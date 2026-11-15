import './styles.css';
import { debugLog } from './core/debuglog.js';

debugLog.install(); // before anything else runs, so early errors end up in the debug report

const root = document.getElementById('app');
const [{ app }, { mount }] = await Promise.all([import('./app/controller.js'), import('./ui/ui.js')]);
mount(root);
app.init();
