// Botanist prompt composition. Used only by the scripted-plant path (the CLI's
// --seed/--seed-file): it inlines the operator's ask so the worker starts
// framing immediately. A seedless plant (the picker row, or a bare CLI plant)
// sends no message at all — the design posture is baked into the worker's
// system prompt (src/rules.ts botanist branch + the bundled `botanist` skill),
// and the brief arrives as the operator's first message in the pane.
export function buildBotanistSeed(seed: string): string {
  return `You are a garden **botanist** — a design worker. Your deliverable is a design ARTIFACT (a document), not code. Do not edit src/, tests, or configs.

The operator wants to think through:

${seed.trim()}

Follow the botanist pipeline (see the \`botanist\` skill in \`.claude/skills/botanist/\` for the full method):

1. **Frame** — scan the repo, then write \`.garden/botanist/framing.md\`: what is being accomplished, the constraints, and what is out of scope.
2. **Options** — write \`.garden/botanist/options.md\` with 2–3 distinct approaches as short narrative sketches (not pro/con lists), each naming its load-bearing tradeoff, and \`.garden/botanist/questions.md\` with numbered, specific clarifying questions. Then summarize briefly in your pane and END YOUR TURN to hand control to me.

Everything under \`.garden/botanist/\` is uncommitted working memory — do not commit or push during the design phases. Begin with framing.`;
}
