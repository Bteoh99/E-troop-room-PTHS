import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/StatusViews';
import { LeaderProvider } from './leader/LeaderContext';
import { ImportPage } from './pages/ImportPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { ItemFormPage } from './pages/ItemFormPage';
import { LocatePage } from './pages/LocatePage';
import { MapPage } from './pages/MapPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RackPage } from './pages/RackPage';
import { SearchPage } from './pages/SearchPage';

/** The scan screen pulls in the barcode + OCR code, so it is loaded only when opened. */
const ScanPage = lazy(() => import('./pages/ScanPage'));

/** React Router v7 opt-in flags (silences upgrade warnings). Use for every Router, including tests. */
export const routerFuture = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

/** Route table. Wrap in a Router (BrowserRouter in main.tsx, MemoryRouter in tests). */
export function AppRoutes() {
  return (
    <LeaderProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<SearchPage />} />
          <Route path="items/new" element={<ItemFormPage />} />
          <Route path="items/:id" element={<ItemDetailPage />} />
          <Route path="items/:id/edit" element={<ItemFormPage />} />
          <Route path="map" element={<MapPage />} />
          <Route path="racks/:rack" element={<RackPage />} />
          <Route path="locate" element={<LocatePage />} />
          <Route
            path="scan"
            element={
              <Suspense fallback={<Loading label="Opening the scanner…" />}>
                <ScanPage />
              </Suspense>
            }
          />
          <Route path="import" element={<ImportPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </LeaderProvider>
  );
}
