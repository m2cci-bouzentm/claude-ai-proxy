// Native context capacities: https://platform.claude.com/docs/en/build-with-claude/context-windows
const contextWindows = new Map<string, number>([
    ["claude-opus-4-8", 1000000],
    ["claude-opus-4-7", 1000000],
    ["claude-opus-4-6", 1000000],
    ["claude-sonnet-4-6", 1000000],
    ["claude-sonnet-4-5-20250929", 200000],
    ["claude-haiku-4-5-20251001", 200000],
    ["claude-opus-5", 1000000],
    ["claude-fable-5", 1000000],
    ["claude-fable-5-1", 1000000],
]);

const aliases = new Map(
    [...contextWindows]
        .filter(([, contextLength]) => contextLength === 1000000)
        .map(([id]) => [`${id}-1m`, id]),
);

export const modelIds = [...contextWindows.keys(), ...aliases.keys()];

export function resolveModelId(model: string): string {
    return aliases.get(model) ?? model;
}

// Discovery presets are client budgets, not server-enforced token limits.
export function getContextLength(model: string): number {
    return aliases.has(model) ? 1000000 : 200000;
}
