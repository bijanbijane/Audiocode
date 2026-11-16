import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { StudioRootBootstrapper } from './ui/bootstrap/StudioRootBootstrapper.tsx';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <StudioRootBootstrapper desktopStudioElement={<App />} />
    </StrictMode>,
  );
}
