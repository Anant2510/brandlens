import { hexToLab, normalizeHex } from '../../common/color';

export type TokenType =
  | 'color'
  | 'dimension'
  | 'fontFamily'
  | 'fontWeight'
  | 'duration'
  | 'number'
  | 'shadow'
  | 'typography'
  | 'other';

export interface NormalizedToken {
  path: string;
  type: TokenType;
  value: unknown;
  description?: string;
  hex?: string;
  /** Precomputed at import time, never at check time. See common/color.ts. */
  lab?: [number, number, number];
}

export type ImportFormat = 'dtcg' | 'style-dictionary' | 'figma-variables' | 'tailwind';

/**
 * Everything normalises to W3C DTCG.
 *
 * Four ecosystems, one internal shape. DTCG is the only format with an actual
 * standards body behind it, and Figma Variables / Style Dictionary / Tailwind
 * are all losslessly expressible in it. Storing the union of four formats
 * instead would push the translation into every consumer of a token — the
 * check engine, the assemble planner, the UI — which is where it would rot.
 */
export function normalizeTokens(format: ImportFormat, payload: Record<string, unknown>): NormalizedToken[] {
  const raw =
    format === 'dtcg'
      ? fromDtcg(payload)
      : format === 'style-dictionary'
        ? fromStyleDictionary(payload)
        : format === 'figma-variables'
          ? fromFigmaVariables(payload)
          : fromTailwind(payload);

  return raw.map(withColorMath);
}

/** Attaches hex + Lab so palette conformance never re-parses a colour. */
function withColorMath(token: NormalizedToken): NormalizedToken {
  if (token.type !== 'color') return token;
  const hex = token.hex ?? normalizeHex(typeof token.value === 'string' ? token.value : String(token.value ?? ''));
  if (!hex) return token;
  const lab = hexToLab(hex);
  return { ...token, hex, ...(lab ? { lab } : {}) };
}

/* --------------------------------------------------------------------------
 * DTCG — https://tr.designtokens.org/format/
 * Groups nest; a token is any node carrying `$value`. `$type` is inherited
 * from the nearest ancestor that declares it.
 * ------------------------------------------------------------------------ */
function fromDtcg(payload: Record<string, unknown>): NormalizedToken[] {
  const out: NormalizedToken[] = [];

  const walk = (node: unknown, path: string[], inheritedType?: string): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const declaredType = (obj.$type ?? obj.type) as string | undefined;
    const effectiveType = declaredType ?? inheritedType;

    if ('$value' in obj || 'value' in obj) {
      const value = '$value' in obj ? obj.$value : obj.value;
      out.push({
        path: path.join('.'),
        type: mapDtcgType(effectiveType, value),
        value,
        description: (obj.$description ?? obj.description) as string | undefined,
      });
      return;
    }

    for (const [key, child] of Object.entries(obj)) {
      if (key.startsWith('$')) continue;
      walk(child, [...path, key], effectiveType);
    }
  };

  walk(payload, []);
  return out;
}

function mapDtcgType(type: string | undefined, value: unknown): TokenType {
  switch (type) {
    case 'color':
      return 'color';
    case 'dimension':
    case 'size':
    case 'spacing':
      return 'dimension';
    case 'fontFamily':
      return 'fontFamily';
    case 'fontWeight':
      return 'fontWeight';
    case 'duration':
      return 'duration';
    case 'number':
      return 'number';
    case 'shadow':
      return 'shadow';
    case 'typography':
      return 'typography';
    default:
      break;
  }
  // No declared type: infer from the value shape rather than dropping to
  // `other`, because Style Dictionary and Tailwind rarely declare one.
  if (typeof value === 'string' && normalizeHex(value)) return 'color';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'object' && value && 'fontFamily' in (value as object)) return 'typography';
  return 'other';
}

/* --------------------------------------------------------------------------
 * Style Dictionary — nested groups with `{ value, comment }` leaves, or the
 * flat `dictionary.allTokens` array from a build.
 * ------------------------------------------------------------------------ */
function fromStyleDictionary(payload: Record<string, unknown>): NormalizedToken[] {
  const all = (payload.allTokens ?? payload.allProperties) as unknown;
  if (Array.isArray(all)) {
    return all.map((t) => {
      const token = t as Record<string, unknown>;
      const path = Array.isArray(token.path) ? (token.path as string[]).join('.') : String(token.name ?? '');
      return {
        path,
        type: mapDtcgType((token.type ?? token.$type) as string | undefined, token.value),
        value: token.value,
        description: token.comment as string | undefined,
      };
    });
  }
  return fromDtcg(payload);
}

/* --------------------------------------------------------------------------
 * Figma Variables — `POST /v1/files/:key/variables` REST payload.
 * Variables live in collections with modes; we take each mode as a path
 * suffix, because a "dark" mode value is a different token for our purposes.
 * ------------------------------------------------------------------------ */
function fromFigmaVariables(payload: Record<string, unknown>): NormalizedToken[] {
  const meta = (payload.meta ?? payload) as Record<string, unknown>;
  const variables = (meta.variables ?? {}) as Record<string, Record<string, unknown>>;
  const collections = (meta.variableCollections ?? {}) as Record<string, Record<string, unknown>>;
  const out: NormalizedToken[] = [];

  for (const variable of Object.values(variables)) {
    const name = String(variable.name ?? '');
    if (!name) continue;
    const resolvedType = String(variable.resolvedType ?? '');
    const collection = collections[String(variable.variableCollectionId ?? '')];
    const modes = (collection?.modes ?? []) as Array<{ modeId: string; name: string }>;
    const valuesByMode = (variable.valuesByMode ?? {}) as Record<string, unknown>;
    const multiMode = modes.length > 1;

    for (const [modeId, rawValue] of Object.entries(valuesByMode)) {
      const modeName = modes.find((m) => m.modeId === modeId)?.name ?? modeId;
      const path = [name.replace(/\//g, '.'), multiMode ? modeName.toLowerCase().replace(/\s+/g, '-') : null]
        .filter(Boolean)
        .join('.');

      if (resolvedType === 'COLOR' && rawValue && typeof rawValue === 'object') {
        const c = rawValue as { r?: number; g?: number; b?: number; a?: number };
        // Figma stores channels as 0..1 floats.
        const to255 = (n: number | undefined) => Math.round(Math.max(0, Math.min(1, n ?? 0)) * 255);
        const hex = `#${[to255(c.r), to255(c.g), to255(c.b)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
        out.push({ path, type: 'color', value: hex, hex, description: variable.description as string | undefined });
        continue;
      }

      out.push({
        path,
        type:
          resolvedType === 'FLOAT'
            ? 'number'
            : resolvedType === 'STRING'
              ? 'other'
              : resolvedType === 'BOOLEAN'
                ? 'other'
                : 'other',
        value: rawValue,
        description: variable.description as string | undefined,
      });
    }
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Tailwind — a `theme` (or `theme.extend`) object from tailwind.config.
 * ------------------------------------------------------------------------ */
function fromTailwind(payload: Record<string, unknown>): NormalizedToken[] {
  const theme = ((payload.theme as Record<string, unknown>) ?? payload) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...theme, ...((theme.extend as Record<string, unknown>) ?? {}) };
  delete merged.extend;

  const out: NormalizedToken[] = [];
  const typeForGroup = (group: string): TokenType => {
    if (group === 'colors' || group === 'backgroundColor' || group === 'textColor' || group === 'borderColor')
      return 'color';
    if (group === 'spacing' || group === 'borderRadius' || group === 'width' || group === 'height') return 'dimension';
    if (group === 'fontFamily') return 'fontFamily';
    if (group === 'fontWeight') return 'fontWeight';
    if (group === 'fontSize') return 'dimension';
    if (group === 'transitionDuration') return 'duration';
    if (group === 'boxShadow') return 'shadow';
    return 'other';
  };

  const walk = (node: unknown, path: string[], group: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node !== 'object' || Array.isArray(node)) {
      out.push({ path: path.join('.'), type: typeForGroup(group), value: node });
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      // Tailwind's `DEFAULT` is the group itself, e.g. colors.brand.DEFAULT.
      walk(child, key === 'DEFAULT' ? path : [...path, key], group);
    }
  };

  for (const [group, value] of Object.entries(merged)) {
    walk(value, [group === 'colors' ? 'color' : group], group);
  }
  return out;
}
