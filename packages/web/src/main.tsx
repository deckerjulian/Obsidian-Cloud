import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { E2eeProvider } from './e2ee/E2eeContext';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <E2eeProvider>
        <App />
      </E2eeProvider>
    </AuthProvider>
  </StrictMode>,
);
