// Lumen Console: a mobile app for Pterodactyl and Hydrodactyl panels, built by Luminare Development.
// Not affiliated with or endorsed by the Pterodactyl project or the Blueprint project.

import { registerRootComponent } from 'expo';

// Defines the background task in the global scope before anything else (expo-task-manager).
import './src/alerts/background';
import App from './App';

registerRootComponent(App);
