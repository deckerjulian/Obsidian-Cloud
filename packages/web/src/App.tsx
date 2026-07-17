import { useAuth } from './auth/AuthContext';
import { LoginForm } from './auth/LoginForm';
import { Workspace } from './components/Workspace';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="oc-spinner-screen">Loading…</div>;
  return user ? <Workspace /> : <LoginForm />;
}
