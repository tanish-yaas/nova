"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Check, Plus, Tag } from "lucide-react";
import { theme } from "@/config/theme";
import { createLabel } from "@/server/actions/labels";
import { useToast } from "@/components/ui/toast";
import { anchorOf } from "@/lib/ui-scale";

export type LabelOption = { id: string; name: string; color: string };

const WIDTH = 220;

export function LabelChip({
  label,
  onRemove,
}: {
  label: LabelOption;
  onRemove?: () => void;
}) {
  return (
    <span
      className="label-chip"
      style={{ "--chip-color": label.color } as React.CSSProperties}
    >
      {label.name}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="opacity-60 transition-opacity hover:opacity-100"
          aria-label={`Remove ${label.name}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Chips plus a dropdown of the workspace's labels. The dropdown portals to the
 * body — a backdrop-filtered ancestor would otherwise trap its fixed position.
 */
export function LabelPicker({
  value,
  options,
  canEdit = true,
  allowCreate = true,
  onChange,
  onCreated,
}: {
  value: string[];
  options: LabelOption[];
  canEdit?: boolean;
  allowCreate?: boolean;
  onChange: (ids: string[]) => void;
  onCreated?: (label: LabelOption) => void;
}) {
  const { push } = useToast();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = anchorOf(buttonRef.current);
    const height = menuRef.current?.offsetHeight ?? 260;

    setPosition({
      left: Math.min(rect.left, rect.viewportWidth - WIDTH - 12),
      top:
        rect.bottom + height + 12 > rect.viewportHeight
          ? Math.max(12, rect.top - height - 6)
          : rect.bottom + 6,
    });
  }, [open, options.length, draft]);

  useEffect(() => {
    if (!open) return;

    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = options.filter((o) => value.includes(o.id));

  function toggle(id: string) {
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id]
    );
  }

  async function create() {
    const name = draft.trim();
    if (!name || creating) return;

    setCreating(true);
    const color = theme.labelPalette[options.length % theme.labelPalette.length];
    const result = await createLabel(name, color);
    setCreating(false);

    if (!result.ok) {
      push(result.error, "error");
      return;
    }

    setDraft("");
    onCreated?.({ id: result.id, name, color });
    onChange([...value, result.id]);
  }

  const menu = (
    <motion.div
      ref={menuRef}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14 }}
      // Marks a layer above any dialog this sits in, so Escape closes this
      // dropdown and not the dialog with the half-filled form under it.
      data-layer="dropdown"
      className="overlay fixed z-[98] p-2"
      style={{ left: position.left, top: position.top, width: WIDTH }}
    >
      <div className="max-h-52 overflow-y-auto">
        {options.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-faint">No labels yet.</p>
        )}
        {options.map((option) => {
          const on = value.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => toggle(option.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[color-mix(in_oklab,white_5%,transparent)]"
            >
              <span
                className="label-chip min-w-0 flex-1"
                style={{ "--chip-color": option.color } as React.CSSProperties}
              >
                <span className="truncate">{option.name}</span>
              </span>
              {on && (
                <Check
                  size={12}
                  className="shrink-0"
                  style={{ color: "var(--primary)" }}
                />
              )}
            </button>
          );
        })}
      </div>

      {allowCreate && (
        <div className="mt-1 border-t border-[color-mix(in_oklab,white_7%,transparent)] pt-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder="New label…"
            className="field"
          />
        </div>
      )}
    </motion.div>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selected.map((label) => (
        <LabelChip
          key={label.id}
          label={label}
          onRemove={canEdit ? () => toggle(label.id) : undefined}
        />
      ))}

      {canEdit && (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="inline-flex h-5 items-center gap-1 rounded-full border border-dashed border-[color-mix(in_oklab,white_16%,transparent)] px-2 text-[11px] text-faint transition-colors hover:border-[var(--primary)] hover:text-foreground"
        >
          {selected.length === 0 ? <Tag size={10} /> : <Plus size={10} />}
          {selected.length === 0 ? "Add label" : "Add"}
        </button>
      )}

      {mounted && open && createPortal(menu, document.body)}
    </div>
  );
}
