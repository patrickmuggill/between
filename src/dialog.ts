/** Dialog padding and keyboard clicks are content, not the backdrop. */
export function isBackdropClick(event: {
  target: EventTarget | null;
  currentTarget: EventTarget & { getBoundingClientRect(): Pick<DOMRect, "left" | "right" | "top" | "bottom"> };
  clientX: number;
  clientY: number;
  detail: number;
}): boolean {
  if (event.target !== event.currentTarget || event.detail === 0) return false;
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right ||
    event.clientY < rect.top || event.clientY > rect.bottom;
}
