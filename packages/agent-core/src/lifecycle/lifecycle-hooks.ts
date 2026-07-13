export type LifecycleHooks = {
  readonly name: "default";
};

export function createDefaultLifecycleHooks(): LifecycleHooks {
  return {
    name: "default"
  };
}

