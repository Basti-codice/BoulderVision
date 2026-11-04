import './styles.css';
import { phoneIdFromHash, runPhoneSender } from './core/phone.js';

const root = document.getElementById('app');
const phoneId = phoneIdFromHash();
if (phoneId) {
  document.body.classList.add('phone-mode');
  runPhoneSender(root, phoneId);
} else {
  const [{ app }, { mount }] = await Promise.all([import('./app/controller.js'), import('./ui/ui.js')]);
  mount(root);
  app.init();
}
