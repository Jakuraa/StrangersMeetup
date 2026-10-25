// Vercel Web Analytics - Initialization Module
// This module imports and initializes Vercel Analytics for tracking page views and events
import { inject } from 'https://cdn.jsdelivr.net/npm/@vercel/analytics@2/dist/index.js';

// Initialize Vercel Analytics
// This will automatically track page views in production
inject();
