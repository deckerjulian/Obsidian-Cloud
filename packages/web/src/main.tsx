import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import './workspace/obsidian.css';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { E2eeProvider } from './e2ee/E2eeContext';
import { VaultProvider } from './vault/VaultContext';
import { installObsidianDom } from './obsidian/dom';
import { applyBaseTheme } from './workspace/appearance';

// Obsidian's DOM helpers are used by the renderer and by community plugins.
installObsidianDom();
applyBaseTheme();

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <E2eeProvider>
        <VaultProvider>
          <App />
        </VaultProvider>
      </E2eeProvider>
    </AuthProvider>
  </StrictMode>,
);
