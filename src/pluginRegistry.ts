// ── Issue #338: Plugin registry with ordered execution ──────────────────────

import type { SoroStreamPlugin, IPluginRegistry } from './types.js';

/**
 * Plugin registry with topological ordering via before/after constraints.
 * Detects circular dependencies on registration.
 */
export class PluginRegistry implements IPluginRegistry {
  private readonly entries: Map<
    SoroStreamPlugin,
    {
      name?: string;
      before: string[];
      after: string[];
    }
  > = new Map();

  register(
    plugin: SoroStreamPlugin,
    constraints?: { name?: string; before?: string; after?: string },
  ): void {
    const beforeList = constraints?.before
      ? Array.isArray(constraints.before)
        ? constraints.before
        : [constraints.before]
      : [];
    const afterList = constraints?.after
      ? Array.isArray(constraints.after)
        ? constraints.after
        : [constraints.after]
      : [];

    // Add entry
    this.entries.set(plugin, {
      name: constraints?.name,
      before: beforeList,
      after: afterList,
    });

    // Validate no circular dependencies
    this.ensureNoCycles();
  }

  list(): SoroStreamPlugin[] {
    return this.topologicalSort();
  }

  unregister(plugin: SoroStreamPlugin): boolean {
    return this.entries.delete(plugin);
  }

  /** Returns all registered plugins in topological order. */
  private topologicalSort(): SoroStreamPlugin[] {
    const plugins = Array.from(this.entries.keys());
    if (plugins.length === 0) return [];

    // Build adjacency: name → plugin
    const nameToPlugin = new Map<string, SoroStreamPlugin>();
    for (const [p, entry] of this.entries) {
      if (entry.name) nameToPlugin.set(entry.name, p);
    }

    // Build edges: plugin → set of plugins that must come after it
    const edges = new Map<SoroStreamPlugin, Set<SoroStreamPlugin>>();
    const inDegree = new Map<SoroStreamPlugin, number>();

    for (const p of plugins) {
      edges.set(p, new Set());
      inDegree.set(p, 0);
    }

    for (const [p, entry] of this.entries) {
      // This plugin must come BEFORE these named plugins
      for (const beforeName of entry.before) {
        const target = nameToPlugin.get(beforeName);
        if (target && target !== p) {
          edges.get(p)!.add(target);
          inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
        }
      }
      // Named plugins in `after` must come BEFORE this plugin
      for (const afterName of entry.after) {
        const source = nameToPlugin.get(afterName);
        if (source && source !== p) {
          edges.get(source)!.add(p);
          inDegree.set(p, (inDegree.get(p) ?? 0) + 1);
        }
      }
    }

    // Kahn's algorithm
    const queue: SoroStreamPlugin[] = [];
    for (const [p, deg] of inDegree) {
      if (deg === 0) queue.push(p);
    }

    const sorted: SoroStreamPlugin[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      for (const neighbor of edges.get(current) ?? new Set()) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (sorted.length !== plugins.length) {
      throw new Error(
        '[SoroStream SDK] Circular dependency detected in plugin registry. ' +
          `Sorted ${sorted.length} of ${plugins.length} plugins. ` +
          'Check your before/after constraints for cycles.',
      );
    }

    return sorted;
  }

  private ensureNoCycles(): void {
    // Trigger cycle detection by attempting a sort
    try {
      this.topologicalSort();
    } catch (e) {
      // Remove the last registered entry on failure to leave registry clean
      const lastKey = Array.from(this.entries.keys()).pop();
      if (lastKey) this.entries.delete(lastKey);
      throw e;
    }
  }
}
