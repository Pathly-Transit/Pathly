import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isAppleSignInAvailable, signInWithApple } from '../auth/appleAuth';
import { useTheme } from '../theme/AppSettings';
import type { GoogleSignInButtonProps } from './GoogleButton';

/**
 * iOS: Apple's own "Continue with Apple" button, as its guidelines require, sized like the
 * Google and guest buttons. Renders nothing where Sign in with Apple isn't available.
 */
export function AppleSignInButton({ disabled, onError, onStart }: GoogleSignInButtonProps) {
  const { scheme } = useTheme();
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void isAppleSignInAvailable().then((value) => { if (active) setAvailable(value); });
    return () => { active = false; };
  }, []);
  if (!available) return null;

  return (
    <View pointerEvents={disabled ? 'none' : 'auto'} style={[styles.wrap, disabled && styles.disabled]} testID="auth-apple">
      <AppleAuthentication.AppleAuthenticationButton
        buttonStyle={scheme === 'dark' ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        cornerRadius={26}
        onPress={() => {
          onStart();
          signInWithApple().catch(onError);
        }}
        style={styles.button}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12 },
  button: { width: '100%', height: 52 },
  disabled: { opacity: 0.5 },
});
