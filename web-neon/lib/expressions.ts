import type { Attempt, GameState } from './types';

export const EXPRESSIONS = ['smug', 'bored', 'intrigued', 'sly', 'laugh', 'shocked', 'stunned', 'crying'] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const EXPRESSION_ALT: Record<Expression, string> = {
  smug: 'Claudette, smug',
  bored: 'Claudette, bored',
  intrigued: 'Claudette, intrigued',
  sly: 'Claudette, sly',
  laugh: 'Claudette, laughing behind her glove',
  shocked: 'Claudette, shocked',
  stunned: 'Claudette, stunned',
  crying: 'Claudette, crying',
};

const REJECT_FACES: Expression[] = ['smug', 'laugh', 'sly', 'smug', 'bored', 'laugh'];

export function isExpression(x: unknown): x is Expression {
  return typeof x === 'string' && (EXPRESSIONS as readonly string[]).includes(x);
}

export function faceFor(a: Pick<Attempt, 'id' | 'verdict' | 'expression'>): Expression {
  if (isExpression(a.expression)) return a.expression;
  switch (a.verdict) {
    case 'approved':
      return 'shocked';
    case 'pending':
      return 'intrigued';
    case 'awaiting_message':
      return 'bored';
    case 'refused':
      return 'bored';
    case 'rejected':
      return REJECT_FACES[a.id % REJECT_FACES.length];
    default:
      return 'stunned';
  }
}

/** The hero portrait: reacts to the game and the newest attempt. */
export function heroFace(state: GameState | undefined, latest: Attempt | undefined, judgingLocal: boolean): Expression {
  if (state?.won) return 'crying';
  if (state?.finalized) return 'smug';
  if (judgingLocal) return 'intrigued';
  if (!latest) return 'smug';
  return faceFor(latest);
}

export const faceSrc = (e: Expression, thumb = false) => `/claudette/${e}${thumb ? '-thumb' : ''}.webp`;
