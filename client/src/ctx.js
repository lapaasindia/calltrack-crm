// The app-wide context lives in its own module so components.jsx and App.jsx
// can both import it without a circular import (App hosts the provider and
// the global prompt/confirm modals; components consume it).
import { createContext, useContext } from 'react';

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);
