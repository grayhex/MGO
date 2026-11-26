import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/dm-sans/latin-700.css';
import '@fontsource/plus-jakarta-sans/latin-500.css';
import '@fontsource/plus-jakarta-sans/latin-600.css';
import '@fontsource/plus-jakarta-sans/latin-700.css';
import '@fontsource/inter/cyrillic-400.css';
import '@fontsource/inter/cyrillic-500.css';
import '@fontsource/inter/cyrillic-600.css';
import '@fontsource/inter/cyrillic-700.css';
import '@fontsource/fira-code/latin-400.css';
import '@fontsource/fira-code/latin-600.css';
import '@fontsource/fira-code/cyrillic-400.css';
import '@fontsource/fira-code/cyrillic-600.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/shell.css';
import './styles/library.css';
import './styles/skin.css';
import './styles/player.css';
import './styles/keypad.css';
import './styles/phones.css';
import './styles/settings.css';
import './styles/archive.css';
import './styles/tv.css';

const TvRemote = lazy(() => import('./tv/Remote'));
const remote = /^\/remote\/?$/.test(location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{remote ? <Suspense fallback={null}><TvRemote /></Suspense> : <App />}</ErrorBoundary>
  </StrictMode>,
);
