import { buildASTSchema, buildSchema, IntrospectionOptions } from 'graphql';
import WebSocket from 'isomorphic-ws';
import { buildGraphQLWSExecutor } from '@graphql-tools/executor-graphql-ws';
import {
  buildHTTPExecutor,
  HTTPExecutorOptions,
  isLiveQueryOperationDefinitionNode,
  type AsyncFetchFn,
  type FetchFn,
  type SyncFetchFn,
} from '@graphql-tools/executor-http';
import { buildWSLegacyExecutor } from '@graphql-tools/executor-legacy-ws';
import {
  AsyncExecutor,
  BaseLoaderOptions,
  ExecutionRequest,
  Executor,
  getOperationASTFromRequest,
  isUrl,
  Loader,
  MaybePromise,
  parseGraphQLSDL,
  Source,
  SyncExecutor,
} from '@graphql-tools/utils';
import { schemaFromExecutor, wrapSchema } from '@graphql-tools/wrap';
import { handleMaybePromise } from '@whatwg-node/promise-helpers';
import { defaultAsyncFetch } from './defaultAsyncFetch.js';
import { defaultSyncFetch } from './defaultSyncFetch.js';

export { FetchFn };

export type AsyncImportFn = (moduleName: string) => PromiseLike<any>;
export type SyncImportFn = (moduleName: string) => any;

const asyncImport: AsyncImportFn = (moduleName: string) => import(`${moduleName}`);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const syncImport: SyncImportFn = (moduleName: string) => require(`${moduleName}`);

type HeadersConfig = Record<string, string>;

interface ExecutionExtensions {
  headers?: HeadersConfig;
  endpoint?: string;
}

export enum SubscriptionProtocol {
  WS = 'WS',
  /**
   * Use legacy web socket protocol `graphql-ws` instead of the more current standard `graphql-transport-ws`
   */
  LEGACY_WS = 'LEGACY_WS',
  /**
   * Use SSE for subscription instead of WebSocket
   */
  SSE = 'SSE',
  /**
   * Use `graphql-sse` for subscriptions
   */
  GRAPHQL_SSE = 'GRAPHQL_SSE',
}

/**
 * Additional options for loading from a URL
 */
export interface LoadFromUrlOptions
  extends BaseLoaderOptions,
    Partial<IntrospectionOptions>,
    HTTPExecutorOptions {
  /**
   * A custom `fetch` implementation to use when querying the original schema.
   * Defaults to `cross-fetch`
   */
  customFetch?: FetchFn | string;
  /**
   * Custom WebSocket implementation used by the loaded schema if subscriptions
   * are enabled
   */
  webSocketImpl?: typeof WebSocket | string;
  /**
   * Handle URL as schema SDL
   */
  handleAsSDL?: boolean;
  /**
   * Regular HTTP endpoint; defaults to the pointer
   */
  endpoint?: string;
  /**
   * Subscriptions endpoint; defaults to the endpoint given as HTTP endpoint
   */
  subscriptionsEndpoint?: string;
  /**
   * Use specific protocol for subscriptions
   */
  subscriptionsProtocol?: SubscriptionProtocol;
  /**
   * Connection Parameters for WebSockets connection
   */
  connectionParams?: Record<string, unknown> | (() => Record<string, unknown>);
  /**
   * Enable Batching
   */
  batch?: boolean;
}

const acceptableProtocols = ['http:', 'https:', 'ws:', 'wss:'];

function isCompatibleUri(uri: string): boolean {
  if (acceptableProtocols.some(protocol => uri.startsWith(protocol))) {
    return isUrl(uri);
  }
  return false;
}

/**
 * This loader loads a schema from a URL. The loaded schema is a fully-executable,
 * remote schema since it's created using [@graphql-tools/wrap](/docs/remote-schemas).
 *
 * ```
 * const schema = await loadSchema('http://localhost:3000/graphql', {
 *   loaders: [
 *     new UrlLoader(),
 *   ]
 * });
 * ```
 */
export class UrlLoader implements Loader<LoadFromUrlOptions> {
  buildHTTPExecutor(
    endpoint: string,
    fetchFn: SyncFetchFn,
    options?: LoadFromUrlOptions,
  ): SyncExecutor<any, ExecutionExtensions>;

  buildHTTPExecutor(
    endpoint: string,
    fetchFn: AsyncFetchFn,
    options?: LoadFromUrlOptions,
  ): AsyncExecutor<any, ExecutionExtensions>;

  buildHTTPExecutor(
    initialEndpoint: string,
    fetchFn: SyncFetchFn | AsyncFetchFn,
    options?: LoadFromUrlOptions,
  ): Executor<any, ExecutionExtensions> {
    const HTTP_URL = switchProtocols(initialEndpoint, {
      wss: 'https',
      ws: 'http',
    });

    return buildHTTPExecutor({
      endpoint: HTTP_URL,
      fetch: fetchFn as any,
      ...options,
    });
  }

  buildWSExecutor(
    subscriptionsEndpoint: string,
    webSocketImpl: typeof WebSocket,
    connectionParams?: Record<string, unknown> | (() => Record<string, unknown>),
  ): Executor {
    const WS_URL = switchProtocols(subscriptionsEndpoint, {
      https: 'wss',
      http: 'ws',
    });
    const opts = {
      url: WS_URL,
      webSocketImpl,
      connectionParams,
    };
    return buildGraphQLWSExecutor(opts);
  }

  buildWSLegacyExecutor(
    subscriptionsEndpoint: string,
    WebSocketImpl: typeof WebSocket,
    options?: LoadFromUrlOptions,
  ): Executor {
    const WS_URL = switchProtocols(subscriptionsEndpoint, {
      https: 'wss',
      http: 'ws',
    });

    return buildWSLegacyExecutor(WS_URL, WebSocketImpl, options);
  }

  getFetch(
    customFetch: LoadFromUrlOptions['customFetch'],
    importFn: AsyncImportFn,
  ): PromiseLike<AsyncFetchFn> | AsyncFetchFn;

  getFetch(customFetch: LoadFromUrlOptions['customFetch'], importFn: SyncImportFn): SyncFetchFn;

  getFetch(
    customFetch: LoadFromUrlOptions['customFetch'],
    importFn: SyncImportFn | AsyncImportFn,
  ): FetchFn | PromiseLike<AsyncFetchFn> {
    if (customFetch) {
      if (typeof customFetch === 'string') {
        const [moduleName, fetchFnName] = customFetch.split('#');
        return handleMaybePromise(
          () => importFn(moduleName),
          module => (fetchFnName ? (module as Record<string, any>)[fetchFnName] : module),
        );
      } else if (typeof customFetch === 'function') {
        return customFetch;
      }
    }
    if (importFn === asyncImport) {
      return defaultAsyncFetch;
    } else {
      return defaultSyncFetch;
    }
  }

  private getDefaultMethodFromOptions(
    method: LoadFromUrlOptions['method'],
    defaultMethod: 'GET' | 'POST',
  ) {
    if (method) {
      defaultMethod = method;
    }
    return defaultMethod;
  }

  getWebSocketImpl(
    importFn: AsyncImportFn,
    options?: LoadFromUrlOptions,
  ): PromiseLike<typeof WebSocket>;

  getWebSocketImpl(importFn: SyncImportFn, options?: LoadFromUrlOptions): typeof WebSocket;

  getWebSocketImpl(
    importFn: SyncImportFn | AsyncImportFn,
    options?: LoadFromUrlOptions,
  ): typeof WebSocket | PromiseLike<typeof WebSocket> {
    if (typeof options?.webSocketImpl === 'string') {
      const [moduleName, webSocketImplName] = options.webSocketImpl.split('#');
      return handleMaybePromise(
        () => importFn(moduleName),
        importedModule => (webSocketImplName ? importedModule[webSocketImplName] : importedModule),
      );
    } else {
      const websocketImpl = options?.webSocketImpl || WebSocket;
      return websocketImpl;
    }
  }

  buildSubscriptionExecutor(
    subscriptionsEndpoint: string,
    fetch: SyncFetchFn,
    syncImport: SyncImportFn,
    options?: LoadFromUrlOptions,
  ): SyncExecutor;

  buildSubscriptionExecutor(
    subscriptionsEndpoint: string,
    fetch: AsyncFetchFn,
    asyncImport: AsyncImportFn,
    options?: LoadFromUrlOptions,
  ): AsyncExecutor;

  buildSubscriptionExecutor(
    subscriptionsEndpoint: string,
    fetch: AsyncFetchFn | SyncFetchFn,
    importFn: AsyncImportFn | SyncImportFn,
    options?: LoadFromUrlOptions,
  ): Executor {
    if (options?.subscriptionsProtocol === SubscriptionProtocol.SSE) {
      return this.buildHTTPExecutor(subscriptionsEndpoint, fetch as AsyncFetchFn, options);
    } else if (options?.subscriptionsProtocol === SubscriptionProtocol.GRAPHQL_SSE) {
      if (!options?.subscriptionsEndpoint) {
        // when no custom subscriptions endpoint is specified,
        // graphql-sse is recommended to be used on `/graphql/stream`
        subscriptionsEndpoint += '/stream';
      }
      return this.buildHTTPExecutor(subscriptionsEndpoint, fetch as AsyncFetchFn, options);
    } else {
      return request =>
        handleMaybePromise(
          () =>
            handleMaybePromise(
              () => this.getWebSocketImpl(importFn, options),
              webSocketImpl => {
                if (options?.subscriptionsProtocol === SubscriptionProtocol.LEGACY_WS) {
                  return this.buildWSLegacyExecutor(subscriptionsEndpoint, webSocketImpl, options);
                } else {
                  return this.buildWSExecutor(
                    subscriptionsEndpoint,
                    webSocketImpl,
                    options?.connectionParams,
                  );
                }
              },
            ),
          executor => executor(request),
        );
    }
  }

  getExecutor(
    endpoint: string,
    asyncImport: AsyncImportFn,
    options?: Omit<LoadFromUrlOptions, 'endpoint'>,
  ): AsyncExecutor;

  getExecutor(
    endpoint: string,
    syncImport: SyncImportFn,
    options?: Omit<LoadFromUrlOptions, 'endpoint'>,
  ): SyncExecutor;

  getExecutor(
    endpoint: string,
    importFn: AsyncImportFn | SyncImportFn,
    options?: Omit<LoadFromUrlOptions, 'endpoint'>,
  ): Executor {
    let fetch$: MaybePromise<ReturnType<typeof this.getFetch>> | undefined;
    const getHttpExecutor = () => {
      return handleMaybePromise(
        () => (fetch$ ||= this.getFetch(options?.customFetch, importFn)),
        fetch => this.buildHTTPExecutor(endpoint, fetch, options),
      );
    };
    const getSetHttpExecutor$ = () => (httpExecutor$ ||= getHttpExecutor());

    let httpExecutor$: ReturnType<typeof getHttpExecutor> | undefined;

    if (
      options?.subscriptionsEndpoint != null ||
      options?.subscriptionsProtocol !== SubscriptionProtocol.SSE
    ) {
      const subscriptionExecutor$ = handleMaybePromise(
        () => (fetch$ ||= this.getFetch(options?.customFetch, importFn)),
        fetch => {
          const subscriptionsEndpoint = options?.subscriptionsEndpoint || endpoint;
          return this.buildSubscriptionExecutor(subscriptionsEndpoint, fetch, importFn, options);
        },
      );

      function getExecutorByRequest(request: ExecutionRequest<any>): MaybePromise<Executor> {
        request.operationType =
          request.operationType || getOperationASTFromRequest(request)?.operation;
        if (
          request.operationType === 'subscription' &&
          isLiveQueryOperationDefinitionNode(getOperationASTFromRequest(request))
        ) {
          request.operationType = 'subscription' as any;
        }
        if (request.operationType === 'subscription') {
          return subscriptionExecutor$;
        } else {
          return getSetHttpExecutor$();
        }
      }

      return request =>
        handleMaybePromise(
          () => getExecutorByRequest(request),
          executor => executor(request),
        );
    } else {
      return request => handleMaybePromise(getSetHttpExecutor$, executor => executor(request));
    }
  }

  getExecutorAsync(
    endpoint: string,
    options?: Omit<LoadFromUrlOptions, 'endpoint'>,
  ): AsyncExecutor {
    return this.getExecutor(endpoint, asyncImport, options);
  }

  getExecutorSync(endpoint: string, options?: Omit<LoadFromUrlOptions, 'endpoint'>): SyncExecutor {
    return this.getExecutor(endpoint, syncImport, options);
  }

  handleSDL(pointer: string, fetch: SyncFetchFn, options: LoadFromUrlOptions): Source;
  handleSDL(pointer: string, fetch: AsyncFetchFn, options: LoadFromUrlOptions): Promise<Source>;
  handleSDL(pointer: string, fetch: FetchFn, options: LoadFromUrlOptions): MaybePromise<Source> {
    const defaultMethod = this.getDefaultMethodFromOptions(options?.method, 'GET');
    return handleMaybePromise(
      () =>
        fetch(pointer, {
          method: defaultMethod,
          headers: typeof options?.headers === 'function' ? options.headers() : options?.headers,
        }),
      res =>
        handleMaybePromise(
          () => res.text(),
          schemaString => parseGraphQLSDL(pointer, schemaString, options),
        ),
    );
  }

  async load(pointer: string, options: LoadFromUrlOptions): Promise<Source[]> {
    if (!isCompatibleUri(pointer)) {
      return [];
    }
    let source: Source = {
      location: pointer,
    };
    let executor: AsyncExecutor | undefined;
    if (options?.handleAsSDL || pointer.endsWith('.graphql') || pointer.endsWith('.graphqls')) {
      const fetch = await this.getFetch(options?.customFetch, asyncImport);
      source = await this.handleSDL(pointer, fetch, options);
      if (!source.schema && !source.document && !source.rawSDL) {
        throw new Error(`Invalid SDL response`);
      }
      source.schema =
        source.schema ||
        (source.document
          ? buildASTSchema(source.document, options)
          : source.rawSDL
            ? buildSchema(source.rawSDL, options)
            : undefined);
    } else {
      executor = this.getExecutorAsync(pointer, options);
      source.schema = await schemaFromExecutor(executor, {}, options);
    }

    if (!source.schema) {
      throw new Error(`Invalid introspected schema`);
    }

    if (options?.endpoint) {
      executor = this.getExecutorAsync(options.endpoint, options);
    }

    if (executor) {
      source.schema = wrapSchema({
        schema: source.schema,
        executor,
        batch: options?.batch,
      });
    }

    return [source];
  }

  loadSync(pointer: string, options: LoadFromUrlOptions): Source[] {
    if (!isCompatibleUri(pointer)) {
      return [];
    }

    let source: Source = {
      location: pointer,
    };
    let executor: SyncExecutor | undefined;
    if (options?.handleAsSDL || pointer.endsWith('.graphql') || pointer.endsWith('.graphqls')) {
      const fetch = this.getFetch(options?.customFetch, syncImport);
      source = this.handleSDL(pointer, fetch, options);
      if (!source.schema && !source.document && !source.rawSDL) {
        throw new Error(`Invalid SDL response`);
      }
      source.schema =
        source.schema ||
        (source.document
          ? buildASTSchema(source.document, options)
          : source.rawSDL
            ? buildSchema(source.rawSDL, options)
            : undefined);
    } else {
      executor = this.getExecutorSync(pointer, options);
      source.schema = schemaFromExecutor(executor, {}, options);
    }

    if (!source.schema) {
      throw new Error(`Invalid introspected schema`);
    }

    if (options?.endpoint) {
      executor = this.getExecutorSync(options.endpoint, options);
    }

    if (executor) {
      source.schema = wrapSchema({
        schema: source.schema,
        executor,
      });
    }

    return [source];
  }
}

function switchProtocols(pointer: string, protocolMap: Record<string, string>): string {
  return Object.entries(protocolMap).reduce(
    (prev, [source, target]) =>
      prev.replace(`${source}://`, `${target}://`).replace(`${source}:\\`, `${target}:\\`),
    pointer,
  );
}
