// Botanist prompt composition. The plant-time seed prompt orients a fresh
// botanist worker to its design role and inlines the operator's ask; the full
// four-phase method lives in the bundled `botanist` skill
// (.claude/skills/botanist/), so this wrapper stays short and points at it.

// Wrap the operator's seed with botanist framing for the plant-time prompt
// (delivered via seedMessageFile, like grow's iter-1 seed). Kicks off the
// frame → options pipeline; the skill carries the detail.
export function buildBotanistSeed(seed: string): string {
  return `You are a garden **botanist** — a design worker. Your deliverable is a design ARTIFACT (a document), not code. Do not edit src/, tests, or configs.

The operator wants to think through:

${seed.trim()}

Follow the botanist pipeline (see the \`botanist\` skill in \`.claude/skills/botanist/\` for the full method):

1. **Frame** — scan the repo, then write \`.garden/botanist/framing.md\`: what is being accomplished, the constraints, and what is out of scope.
2. **Options** — write \`.garden/botanist/options.md\` with 2–3 distinct approaches as short narrative sketches (not pro/con lists), each naming its load-bearing tradeoff, and \`.garden/botanist/questions.md\` with numbered, specific clarifying questions. Then summarize briefly in your pane and END YOUR TURN to hand control to me.

Everything under \`.garden/botanist/\` is uncommitted working memory — do not commit or push during the design phases. Begin with framing.`;
}
