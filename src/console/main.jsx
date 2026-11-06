import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import '../styles.css';
import Console from './Console.jsx';

createRoot(document.getElementById('root')).render(<StrictMode><Console /></StrictMode>);
