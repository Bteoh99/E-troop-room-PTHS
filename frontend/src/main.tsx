import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes, routerFuture } from './App';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter future={routerFuture}>
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>,
);
