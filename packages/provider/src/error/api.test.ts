import { ServiceError } from '@lowerdeck/error';
import { describe, expect, it } from 'vitest';
import { buildApiServiceError, collectApiErrorDetails, createApiServiceError } from './api';
import { SlateError } from './base';

describe('API service error helpers', () => {
  it('collects unique nested API error details', () => {
    let details: string[] = [];

    collectApiErrorDetails(
      {
        message: 'Invalid request',
        code: 'bad_request',
        errors: [
          {
            detail: 'Missing name'
          },
          'Missing name'
        ]
      },
      details
    );

    expect(details).toEqual(['Invalid request', 'bad_request', 'Missing name']);
  });

  it('builds provider API ServiceErrors with upstream metadata', () => {
    let parent = new Error('Request failed');
    (parent as any).response = {
      status: 429,
      statusText: 'Too Many Requests',
      data: {
        title: 'Rate limit',
        details: [{ message: 'Retry later' }]
      }
    };

    let error = buildApiServiceError(parent, {
      providerLabel: 'Example',
      operation: 'list widgets',
      reason: 'example_api_error',
      detailKeys: ['title', 'message'],
      nestedKeys: ['details'],
      extractUpstreamCode: () => 'RATE_LIMITED'
    });

    expect(error).toBeInstanceOf(ServiceError);
    expect(error.data.message).toBe(
      'Example API list widgets failed: HTTP 429 Too Many Requests: Rate limit - Retry later'
    );
    expect(error.data.reason).toBe('example_api_error');
    expect(error.data.upstreamStatus).toBe(429);
    expect(error.data.upstreamCode).toBe('RATE_LIMITED');
  });

  it('recovers the upstream status from interceptor-normalized SlateErrors', () => {
    // Runtime axios instances reject with SlateError, not AxiosError: the
    // response interceptor consumes error.response, so the status only
    // survives at data.upstream.status / data.status.
    let parent = new SlateError({
      code: 'not_found',
      message: 'Method not found.',
      upstream: { status: 404 }
    });

    let error = buildApiServiceError(parent, {
      providerLabel: 'Example',
      operation: 'search messages',
      reason: 'example_api_error'
    });

    expect(error.data.upstreamStatus).toBe(404);
    expect(error.data.message).toBe(
      'Example API search messages failed: HTTP 404: Method not found.'
    );
  });

  it('allows provider-specific status and message extraction', () => {
    let error = buildApiServiceError(
      {
        status: 503,
        data: {
          message: 'Unavailable'
        }
      },
      {
        providerLabel: 'Example',
        reason: 'example_api_error',
        extractStatus: (input, _response, helpers) =>
          helpers.isRecord(input) && typeof input.status === 'number'
            ? input.status
            : undefined,
        extractMessage: (input, helpers) => {
          if (!helpers.isRecord(input) || !helpers.isRecord(input.data)) return undefined;
          return typeof input.data.message === 'string' ? input.data.message : undefined;
        }
      }
    );

    expect(error.data.message).toBe('Example API request failed: HTTP 503: Unavailable');
    expect(error.data.upstreamStatus).toBe(503);
  });

  it('passes through existing ServiceErrors', () => {
    let existing = createApiServiceError('Already normalized');

    expect(
      buildApiServiceError(existing, {
        providerLabel: 'Example',
        reason: 'example_api_error'
      })
    ).toBe(existing);
  });

  it('keeps the classification of the upstream failure it wraps', () => {
    // What createAxios rejects with for an upstream 503.
    let parent = new SlateError({
      code: 'upstream.unavailable',
      message: 'Service Unavailable',
      upstream: { status: 503 }
    });

    let error = SlateError.fromUnknown(
      buildApiServiceError(parent, {
        providerLabel: 'Example',
        operation: 'list widgets',
        reason: 'example_api_error'
      })
    );

    expect(error.toResponse()).toMatchObject({
      code: 'upstream.unavailable',
      kind: 'upstream',
      message: 'Example API list widgets failed: HTTP 503: Service Unavailable',
      retryable: true,
      status: 503,
      upstream: { status: 503 }
    });
  });

  it('classifies by upstream status when the caller drops the parent', () => {
    let parent = new SlateError({
      code: 'upstream.rate_limited',
      message: 'Too Many Requests',
      upstream: { status: 429 }
    });

    let error = SlateError.fromUnknown(
      buildApiServiceError(parent, {
        providerLabel: 'Example',
        reason: 'example_api_error',
        parent: {},
        extractUpstreamCode: () => 'RATE_LIMITED'
      })
    );

    expect(error.toResponse()).toMatchObject({
      code: 'upstream.rate_limited',
      retryable: true,
      status: 429,
      upstream: { status: 429, code: 'RATE_LIMITED' }
    });
  });

  it('keeps request.bad for errors that carry no upstream failure', () => {
    let error = SlateError.fromUnknown(
      createApiServiceError('Owner is required.', { reason: 'example_validation' })
    );

    expect(error.code).toBe('request.bad');
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
  });
});
