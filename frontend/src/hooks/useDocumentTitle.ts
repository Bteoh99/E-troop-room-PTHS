import { useEffect } from 'react';

const APP = 'e-Troop Store Room';

export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${APP}` : APP;
  }, [title]);
}
