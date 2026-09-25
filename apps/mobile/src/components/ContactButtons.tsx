import { View, Text, Pressable, StyleSheet, Linking } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { getOrderContact } from "../api/contacts";
import { colors, radii, typography, spacing } from "../theme/tokens";

/**
 * Кнопки связи «Позвонить / WhatsApp» — те же, что у заказчика в списке откликов.
 * Контакт подгружается сам (GET /orders/{id}/contacts/{userId} отдаёт его только сторонам раскрытого контакта).
 */
export function ContactButtons({ orderId, userId }: { orderId: string; userId: string }) {
  const query = useQuery({
    queryKey: ["order-contact", orderId, userId],
    queryFn: () => getOrderContact(orderId, userId),
    retry: false,
  });
  const contact = query.data;
  if (!contact) return null;
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.button, styles.call, pressed && styles.pressed]}
        onPress={() => Linking.openURL(`tel:${contact.phone}`)}
      >
        <Text style={styles.callText}>Позвонить</Text>
      </Pressable>
      {/* Если отдельный номер WhatsApp не указан, пишем на основной номер телефона. */}
      <Pressable
        style={({ pressed }) => [styles.button, styles.whatsapp, pressed && styles.pressed]}
        onPress={() => Linking.openURL(`https://wa.me/${(contact.whatsappPhone ?? contact.phone).replace(/[^\d]/g, "")}`)}
      >
        <Text style={styles.whatsappText}>WhatsApp</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  button: { flex: 1, minHeight: 48, borderRadius: radii.button, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.85 },
  call: { backgroundColor: colors.primaryTintBg },
  callText: { ...typography.subtitle, fontWeight: "700", color: colors.primary },
  whatsapp: { backgroundColor: colors.successTintBg },
  whatsappText: { ...typography.subtitle, fontWeight: "700", color: colors.success },
});
