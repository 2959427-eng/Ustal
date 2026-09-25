import type { ReactNode } from "react";
import { KeyboardAvoidingView, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

interface Props {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Поднимает содержимое над клавиатурой на iOS и Android.
 * 2026-09-21 fix: на Android (edge-to-edge в Expo SDK 57) окно больше не сжимается под
 * клавиатуру сама, поле ввода оказывалось под клавиатурой и текста не было видно. Раньше
 * отступ делался только на iOS (behavior "padding" только для Platform.OS === "ios").
 * Если окно всё же сжалось системой (старый режим adjustResize), клавиатура уже не
 * перекрывает вью и отступ равен нулю, то есть двойного сдвига не будет.
 */
export function KeyboardAvoid({ children, style }: Props) {
  return (
    <KeyboardAvoidingView style={[styles.flex, style]} behavior="padding">
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
