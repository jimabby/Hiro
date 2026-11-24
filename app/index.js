import { registerRootComponent } from 'expo'
import App from './App'
import { registerPracticeWidget } from './src/widget'

registerRootComponent(App)
// The Practice home-screen widget's background task (Android only).
registerPracticeWidget()
