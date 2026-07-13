export type RuntimePolicies = {
  readonly queue: "direct";
  readonly retry: "none";
  readonly compaction: "disabled";
};

export function createDefaultRuntimePolicies(): RuntimePolicies {
  return {
    queue: "direct",
    retry: "none",
    compaction: "disabled"
  };
}

