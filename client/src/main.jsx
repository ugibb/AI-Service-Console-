import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createApiClient } from './api/client.js';
import './styles/tokens.css';
import './styles/global.css';

const api = createApiClient();
const container = document.getElementById('root');

if (!container) {
  throw new Error('找不到 #root 挂载点，请检查 index.html');
}

createRoot(container).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
