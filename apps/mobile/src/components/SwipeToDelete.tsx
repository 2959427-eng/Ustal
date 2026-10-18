import { useRef, useState, type ReactNode } from "react";
import { Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, typography } from "../theme/tokens";

const ACTION_WIDTH = 104;
/** Жест начинается уже с ~6 px и ведёт себя как горизонтальный, если палец идёт больше вбок, чем вверх/вниз. */
const START_DISTANCE = 6;
const FLICK_VELOCITY = 0.35;

interface Props {
  children: ReactNode;
  onDelete: () => void;
  /** false — свайп отключён (например, заказ уже нельзя удалить). */
  enabled?: boolean;
  /**
   * Горизонтальный отступ списка, в котором лежит карточка. Зона свайпа растягивается на него,
   * то есть на всю ширину экрана: жест, начатый у самого края (палец с рамки телефона на экран),
   * тоже ловится, как в мессенджерах.
   */
  edgeInset?: number;
}

/**
 * Свайп влево по любой части карточки открывает кнопку «Удалить» (без внешних библиотек жестов).
 *
 * 2026-09-21: раньше жест ловился только «в самой карточке» с порогом 10 px и без учёта скорости —
 * дёргался и срабатывал не всегда. Теперь: жест перехватывается в capture-фазе (работает поверх
 * фото, текста и кнопок внутри карточки), порог меньше, карточка идёт за пальцем 1:1, а открытие
 * решает и смещение, и скорость броска. Системный жест «Назад» у самого края экрана Android
 * перехватывает ОС — приложение его отключить не может, поэтому свайп надо начинать чуть правее края.
 *
 * Пока кнопка открыта, нажатие по карточке закрывает её, а не открывает заказ.
 */
export function SwipeToDelete({ children, onDelete, enabled = true, edgeInset = spacing.lg }: Props) {
  const x = useRef(new Animated.Value(0)).current;
  const current = useRef(0);
  const startX = useRef(0);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);

  // Текущая позиция нужна, чтобы подхватить жест посреди анимации.
  const listenerId = useRef<string | null>(null);
  if (listenerId.current === null) {
    listenerId.current = x.addListener(({ value }) => {
      current.current = value;
    });
  }

  const snap = (toOpen: boolean) => {
    openRef.current = toOpen;
    setOpen(toOpen);
    Animated.timing(x, {
      toValue: toOpen ? -ACTION_WIDTH : 0,
      duration: 170,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        Math.abs(g.dx) > START_DISTANCE && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > START_DISTANCE && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        x.stopAnimation();
        startX.current = current.current;
      },
      onPanResponderMove: (_e, g) => {
        x.setValue(Math.max(-ACTION_WIDTH, Math.min(0, startX.current + g.dx)));
      },
      onPanResponderRelease: (_e, g) => {
        if (g.vx < -FLICK_VELOCITY) return snap(true);
        if (g.vx > FLICK_VELOCITY) return snap(false);
        snap(current.current < -ACTION_WIDTH / 3);
      },
      onPanResponderTerminate: () => snap(openRef.current),
    }),
  ).current;

  if (!enabled) return <View style={styles.touchArea}>{children}</View>;

  return (
    <View
      style={[styles.touchArea, { marginHorizontal: -edgeInset, paddingHorizontal: edgeInset }]}
      {...pan.panHandlers}
    >
    <View style={styles.wrap}>
      <View style={styles.actionSlot}>
        <Pressable
          style={styles.action}
          onPress={() => {
            snap(false);
            onDelete();
          }}
          accessibilityRole="button"
          accessibilityLabel="Удалить заказ"
        >
          <Text style={styles.actionText}>Удалить</Text>
        </Pressable>
      </View>
      <Animated.View style={{ transform: [{ translateX: x }] }}>
        {children}
        {open && <Pressable style={StyleSheet.absoluteFill} onPress={() => snap(false)} accessibilityLabel="Закрыть" />}
      </Animated.View>
    </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Прозрачная зона касания на всю ширину экрана и чуть выше/ниже карточки (промежутки между карточками).
  touchArea: { paddingVertical: 4 },
  wrap: { borderRadius: radii.lg, overflow: "hidden" },
  actionSlot: { ...(StyleSheet.absoluteFill as object), alignItems: "flex-end", justifyContent: "center", backgroundColor: colors.danger },
  action: { width: ACTION_WIDTH, height: "100%", alignItems: "center", justifyContent: "center" },
  actionText: { ...typography.body, color: colors.textInverse, fontWeight: "700" },
});
