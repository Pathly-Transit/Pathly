import { Nunito_400Regular } from '@expo-google-fonts/nunito/400Regular';
import { Nunito_600SemiBold } from '@expo-google-fonts/nunito/600SemiBold';
import { Nunito_700Bold } from '@expo-google-fonts/nunito/700Bold';
import { Nunito_800ExtraBold } from '@expo-google-fonts/nunito/800ExtraBold';
import { Nunito_900Black } from '@expo-google-fonts/nunito/900Black';
import { useFonts } from '@expo-google-fonts/nunito/useFonts';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from './src/auth/AuthContext';
import { needsEmailConfirmation } from './src/auth/authService';
import { AuthScreen } from './src/components/AuthScreen';
import { HomeScreen } from './src/components/HomeScreen';
import { LoadingScreen } from './src/components/LoadingScreen';
import { OnboardingScreen } from './src/components/OnboardingScreen';
import { VerifyEmailScreen } from './src/components/VerifyEmailScreen';
import { UserPreferencesProvider } from './src/data/userPreferences';
import { useOnboarding } from './src/hooks/useOnboarding';
import { prewarmLocation } from './src/hooks/useCurrentLocation';
import { DebugProvider } from './src/debug/DebugContext';
import { AppSettingsProvider } from './src/theme/AppSettings';

function AppContent() {
  const { initializing, user } = useAuth();
  const onboarding = useOnboarding(user && !needsEmailConfirmation(user) ? user : null);
  if (initializing) return <LoadingScreen />;
  if (!user) return <AuthScreen />;
  if (needsEmailConfirmation(user)) return <VerifyEmailScreen />;
  // A new account's first page, once: its usual places, then the app.
  if (onboarding.state === 'loading') return <LoadingScreen />;
  if (onboarding.state === 'pending') return <OnboardingScreen onDone={onboarding.finish} />;
  return <HomeScreen />;
}

export default function App() {
  // Locating starts while fonts load and the session is restored, if access is already granted.
  useEffect(prewarmLocation, []);
  const [fontsLoaded] = useFonts({
    Nunito_400Regular,
    Nunito_600SemiBold,
    Nunito_700Bold,
    Nunito_800ExtraBold,
    Nunito_900Black,
    ...Ionicons.font,
    ...MaterialCommunityIcons.font,
  });

  if (!fontsLoaded) return <LoadingScreen />;

  return (
    <SafeAreaProvider>
      <AppSettingsProvider>
        <AuthProvider>
          <UserPreferencesProvider>
            <DebugProvider>
              <AppContent />
            </DebugProvider>
          </UserPreferencesProvider>
        </AuthProvider>
      </AppSettingsProvider>
    </SafeAreaProvider>
  );
}
