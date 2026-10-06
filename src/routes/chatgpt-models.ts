import type { FastifyInstance } from 'fastify';
import type { GatewayDeps } from '../app.js';

export function registerChatGptModelsRoute(app: FastifyInstance, gateway: GatewayDeps): void {
  app.get('/chatgpt/v1/models', { preHandler: gateway.requireProviderKey('chatgpt') }, () => gateway.chatGptUpstream.listModels());
}
