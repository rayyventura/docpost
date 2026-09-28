import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TreeSlots {
  docs: HTMLElement | null;
  send: HTMLElement | null;
}

const SidebarTreeSlotContext = createContext<TreeSlots>({ docs: null, send: null });

export function SidebarTreeSlotProvider({
  docs,
  send,
  children,
}: {
  docs: HTMLElement | null;
  send: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <SidebarTreeSlotContext.Provider value={{ docs, send }}>
      {children}
    </SidebarTreeSlotContext.Provider>
  );
}

export function SidebarTree({
  children,
  pane,
}: {
  children: ReactNode;
  pane: 'docs' | 'send';
}) {
  const slots = useContext(SidebarTreeSlotContext);
  const slot = slots[pane];
  if (!slot) return null;
  return createPortal(children, slot);
}
