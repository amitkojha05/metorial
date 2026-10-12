import { badRequestError, ServiceError } from '@lowerdeck/error';
import { describe, expect, it } from 'vitest';
import { buildApiServiceError } from '../../../provider/src/error/api';
import { SlateError } from '../../../provider/src/error/base';
import {
  createSlatesProviderProtoHandler,
  SlatesProviderProtoHandlerManager
} from './provider';

describe('SlatesProviderProtoHandlerManager', () => {
  it('serializes SlateError instances directly into JSON-RPC errors', async () => {
    let manager = await createSlatesProviderProtoHandler(async manager => {
      manager.onRequest('slates/provider.identify', async () => {
        throw new SlateError({
          code: 'upstream.rate_limited',
          kind: 'upstream',
          message: 'GitHub rate limit exceeded',
          retryable: true,
          upstream: {
            status: 429,
            code: 'rate_limited'
          },
          baggage: {
            scope: 'issues'
          }
        });
      });
    }).run();

    let response = await SlatesProviderProtoHandlerManager.handleInput(manager, {
      jsonrpc: '2.0',
      id: 'req_1',
      method: 'slates/provider.identify',
      params: {}
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'req_1',
      error: {
        code: 'upstream.rate_limited',
        kind: 'upstream',
        message: 'GitHub rate limit exceeded',
        retryable: true,
        status: 429,
        upstream: {
          status: 429,
          code: 'rate_limited'
        },
        baggage: {
          scope: 'issues'
        }
      }
    });
  });

  it('maps ServiceError instances to SlateError protocol responses', async () => {
    let manager = await createSlatesProviderProtoHandler(async manager => {
      manager.onRequest('slates/provider.identify', async () => {
        throw new ServiceError(
          badRequestError({
            message: 'Invalid provider state'
          })
        );
      });
    }).run();

    let response = await SlatesProviderProtoHandlerManager.handleInput(manager, {
      jsonrpc: '2.0',
      id: 'req_2',
      method: 'slates/provider.identify',
      params: {}
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'req_2',
      error: {
        code: 'request.bad',
        kind: 'request',
        message: 'Invalid provider state',
        retryable: false,
        status: 400,
        baggage: {
          serviceError: {
            code: 'bad_request',
            status: 400
          }
        }
      }
    });
  });

  // What createAxios rejects with for an upstream 503 or 429.
  let upstreamError = (code: string, status: number) =>
    new SlateError({ code, message: `Upstream returned ${status}`, upstream: { status } });

  it.each([
    ['upstream.unavailable', 503, {}],
    ['upstream.rate_limited', 429, {}],
    // Callers that drop the parent still record the upstream status.
    ['upstream.unavailable', 503, { parent: {} }],
    ['upstream.rate_limited', 429, { parent: {} }]
  ])('keeps %s for a wrapped upstream %i %j', async (code, status, options) => {
    let manager = await createSlatesProviderProtoHandler(async manager => {
      manager.onRequest('slates/provider.identify', async () => {
        throw buildApiServiceError(upstreamError(code, status), {
          providerLabel: 'Example',
          operation: 'list widgets',
          reason: 'example_api_error',
          ...options
        });
      });
    }).run();

    let response = await SlatesProviderProtoHandlerManager.handleInput(manager, {
      jsonrpc: '2.0',
      id: 'req_wrapped',
      method: 'slates/provider.identify',
      params: {}
    });

    expect(response).toMatchObject({
      error: {
        code,
        kind: 'upstream',
        message: `Example API list widgets failed: HTTP ${status}: Upstream returned ${status}`,
        retryable: true,
        status,
        upstream: { status },
        baggage: {
          serviceError: { code: 'bad_request', reason: 'example_api_error' }
        }
      }
    });
  });

  it('returns slate errors for protocol validation failures', async () => {
    let manager = await createSlatesProviderProtoHandler(async () => {}).run();

    let response = await SlatesProviderProtoHandlerManager.handleInput(manager, {
      jsonrpc: '1.0',
      id: 'req_3',
      method: 'slates/provider.identify',
      params: {}
    } as any);

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'req_3',
      error: {
        code: 'request.bad',
        kind: 'request',
        message: 'Invalid jsonrpc version',
        retryable: false,
        status: 400,
        baggage: {
          serviceError: {
            code: 'bad_request',
            status: 400
          }
        }
      }
    });
  });
});
