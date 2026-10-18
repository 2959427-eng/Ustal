import { useEffect } from "react";
import { ApiRequestError } from "@ustal/api-client";
import { View, Text, Pressable, StyleSheet, Linking } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getOrderContact } from "../api/contacts";
import { colors, radii, typography, spacing } from "../theme/tokens";

/**
 * Кнопки связи «Позвонить / WhatsApp» — те же, что у заказчика в списке откликов.
 * Контакт подгружается сам (GET /orders/{id}/contacts/{userId} отдаёт его только сторонам раскрытого контакта).
 */
export function ContactButtons({ orderId, userId }: { orderId: string; userId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["order-contact", orderId, userId],
    queryFn: async () => {
      try {
        return await getOrderContact(orderId, userId);
      } catch (error) {
        if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) return null;
        throw error;
      }
    },
    retry: false,
  });
  const denied = query.error instanceof ApiRequestError && (query.error.status === 403 || query.error.status === 404);
  // Purge denial errors cached by an older observer too; never overwrite a newer successful fetch.
  useEffect(() => {
    const key = ["order-contact", orderId, userId];
    if (denied && queryClient.getQueryState(key)?.error === query.error) queryClient.setQueryData(key, null);
  }, [denied, orderId, userId, query.error, queryClient]);
  const contact = query.data;
  if (denied || !contact) return null;
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
