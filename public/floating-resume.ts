export interface ResumeGeometry {
  top: number;
  bottom: number;
  anchorBottom: number;
  disabled: boolean;
}

export interface ResumeSelection {
  index: number;
  floating: boolean;
}

export function selectResume(
  top: number,
  bottom: number,
  conversations: readonly ResumeGeometry[],
): ResumeSelection | null {
  if (bottom <= top) return null;
  const readingLine = top + Math.min(80, (bottom - top) * 0.2);
  const index = conversations.findIndex(
    (conversation) => conversation.top <= readingLine && conversation.bottom > readingLine,
  );
  const conversation = conversations[index];
  if (!conversation || conversation.disabled) return null;
  return { index, floating: conversation.anchorBottom <= top };
}

interface ResumeTarget {
  conversation: HTMLElement;
  anchor: HTMLElement;
  button: HTMLButtonElement;
}

export function createFloatingResume(reader: HTMLElement) {
  let targets: ResumeTarget[] = [];
  let floating: ResumeTarget | undefined;
  let frame: number | undefined;

  function update(): void {
    frame = undefined;
    const viewport = reader.getBoundingClientRect();
    const geometry = targets.map((target) => {
      const bounds = target.conversation.getBoundingClientRect();
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        anchorBottom: target.anchor.getBoundingClientRect().bottom,
        disabled: target.button.disabled,
      };
    });
    const selection = selectResume(viewport.top, viewport.bottom, geometry);
    const reading = selection ? targets[selection.index] : undefined;
    const next = selection?.floating ? reading : undefined;
    if (floating === next) return;

    const transferFocus = floating?.button === document.activeElement;
    floating?.button.classList.remove('is-floating');
    floating?.button.classList.add('is-docking');
    next?.button.classList.remove('is-docking');
    next?.button.classList.add('is-floating');
    floating = next;
    if (transferFocus) (reading?.button ?? reader).focus({ preventScroll: true });
  }

  function refresh(): void {
    if (frame === undefined) frame = requestAnimationFrame(update);
  }
  const resize = new ResizeObserver(refresh);
  resize.observe(reader);
  reader.addEventListener('scroll', refresh, { passive: true });
  window.addEventListener('resize', refresh);

  return {
    register(target: ResumeTarget): void {
      targets.push(target);
      resize.observe(target.conversation);
      refresh();
    },
    refresh,
    reset(): void {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      for (const target of targets) target.button.classList.remove('is-floating', 'is-docking');
      targets = [];
      floating = undefined;
      resize.disconnect();
      resize.observe(reader);
    },
  };
}
