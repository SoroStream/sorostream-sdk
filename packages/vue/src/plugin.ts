import { inject, type App, type InjectionKey } from 'vue';
import type { SoroStreamClient } from '@sorostream/sdk';

/** Injection key under which {@link SoroStreamPlugin} provides the client. */
export const SoroStreamClientKey: InjectionKey<SoroStreamClient> = Symbol('SoroStreamClient');

export interface SoroStreamPluginOptions {
  client: SoroStreamClient;
}

/**
 * Vue 3 plugin that provides a SoroStream client to every component, so
 * Composition API code can read it with {@link useSoroStreamClient}.
 *
 * @example
 * ```ts
 * app.use(SoroStreamPlugin, { client });
 * ```
 * ```vue
 * <script setup lang="ts">
 * import { useSoroStreamClient, useStream } from "@sorostream/vue";
 * const client = useSoroStreamClient();
 * const { stream } = useStream(client, props.streamId);
 * </script>
 * ```
 */
export const SoroStreamPlugin = {
  install(app: App, options: SoroStreamPluginOptions): void {
    if (!options?.client) throw new Error('SoroStreamPlugin: `client` option is required');
    app.provide(SoroStreamClientKey, options.client);
  },
};

/**
 * Returns the client provided by {@link SoroStreamPlugin}. Must be called
 * inside `setup()` / `<script setup>`.
 */
export function useSoroStreamClient(): SoroStreamClient {
  const client = inject(SoroStreamClientKey, null);
  if (!client) {
    throw new Error(
      'useSoroStreamClient: no client provided — call app.use(SoroStreamPlugin, { client })',
    );
  }
  return client;
}
