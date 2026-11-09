import { useEffect, useState } from 'react';
import { PERSONAS } from './personas';
import { loadBackground, loadCharacter, loadSheet, type CharacterSprite } from './spriteSheet';
import type { SpriteBank } from './renderer';

const SPRITE_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/sprites`;
const PIXEL_FONT = '8px "Pixelify Sans", ui-monospace, monospace';

/** Load every character sheet, props and background, falling back to placeholders. */
export function useSpriteBank(): SpriteBank | null {
  const [bank, setBank] = useState<SpriteBank | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await Promise.race([document.fonts.load(PIXEL_FONT), new Promise((r) => setTimeout(r, 1500))]);
      } catch {
        // system monospace fallback
      }
      const characters = new Map<string, CharacterSprite>();
      await Promise.all(
        PERSONAS.map(async (p) => characters.set(p.agentId, await loadCharacter(SPRITE_BASE, p, '10px "Pixelify Sans", ui-monospace, monospace'))),
      );
      const props = await loadSheet(SPRITE_BASE, 'props').catch(() => null);
      const background = await loadBackground(SPRITE_BASE);
      if (!cancelled) setBank({ characters, props, background, font: PIXEL_FONT });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return bank;
}

