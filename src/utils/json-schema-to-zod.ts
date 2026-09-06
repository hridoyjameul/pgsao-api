import { z } from 'zod';
import { ApiError } from '../errors/api-error.js';

/**
 * Minimal JSON Schema -> Zod converter for tool parameter schemas (PRD Phase
 * 3 / NG6). `createSdkMcpServer`/`tool()` in the Claude Agent SDK require a
 * Zod raw shape, but real OpenAI (`function.parameters`) and Anthropic
 * (`input_schema`) tool definitions are JSON Schema. Deliberately supports
 * only the realistic subset tool schemas actually use (object/string/number/
 * integer/boolean/array/enum, required, nested objects/arrays, description)
 * — unsupported constructs (oneOf/anyOf/allOf/$ref/not/conditionals) are
 * rejected with a clear invalid_request_error rather than silently
 * misconverted (R9), not a full JSON Schema implementation.
 */
export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject;
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
}

const UNSUPPORTED_KEYS = ['oneOf', 'anyOf', 'allOf', 'not', '$ref', 'if', 'then', 'else'] as const;

function assertSupported(schema: JsonSchemaObject, path: string): void {
  for (const key of UNSUPPORTED_KEYS) {
    if (key in schema) {
      throw new ApiError('invalid_request_error', `Unsupported JSON Schema construct "${key}" in tool parameter schema at "${path}" — only a plain object/string/number/integer/boolean/array/enum subset is supported`, { param: path });
    }
  }
}

function convert(schema: JsonSchemaObject, path: string): z.ZodTypeAny {
  assertSupported(schema, path);

  let zodType: z.ZodTypeAny;
  if (schema.enum) {
    const values = schema.enum as [string, ...string[]];
    zodType = z.enum(values);
  } else {
    switch (schema.type) {
      case 'string':
        zodType = z.string();
        break;
      case 'number':
        zodType = z.number();
        break;
      case 'integer':
        zodType = z.number().int();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        zodType = z.array(schema.items ? convert(schema.items, `${path}[]`) : z.unknown());
        break;
      case 'object':
      case undefined:
        zodType = z.object(jsonSchemaObjectToZodRawShape(schema, path));
        break;
      default:
        throw new ApiError('invalid_request_error', `Unsupported JSON Schema type "${schema.type}" in tool parameter schema at "${path}"`, { param: path });
    }
  }
  if (schema.description) zodType = zodType.describe(schema.description);
  return zodType;
}

/** Converts a top-level JSON Schema object (a tool's `parameters`/`input_schema`) into a Zod raw shape. */
export function jsonSchemaObjectToZodRawShape(schema: JsonSchemaObject, path = '$'): Record<string, z.ZodTypeAny> {
  assertSupported(schema, path);
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    let zodType = convert(propSchema, `${path}.${key}`);
    if (!required.has(key)) zodType = zodType.optional();
    shape[key] = zodType;
  }
  return shape;
}
