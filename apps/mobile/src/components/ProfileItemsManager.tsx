import { useMemo, useRef, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { getProfile, profileItemAction, type ProfileResponse } from "../api/profile";
import { createItemActions, ITEM_ACTION_LABEL, profileItemRows, REMOVED_KIND_LABEL, type ItemActionState, type ItemRow } from "../lib/profile-item-actions";
import { colors, spacing, typography } from "../theme/tokens";

/**
 * Сохранённые пункты профиля с прямыми действиями без AI (2026-10-17): «Убрать», «Снять ограничение»,
 * «Восстановить» (блок «Убранные», свёрнут по умолчанию). Логика — src/lib/profile-item-actions.ts:
 * server action → полный GET /profile; одно действие за раз; ошибка — пункт остаётся как был.
 */
export function ProfileItemsManager({ profile }: { profile: ProfileResponse }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ItemActionState>({ pendingKey: null, error: null, errorKey: null });
  const [showRemoved, setShowRemoved] = useState(false);
  const rows = useMemo(() => profileItemRows(profile), [profile]);
  const actions = useRef(createItemActions({
    call: profileItemAction,
    refresh: async () => {
      // Свежий профиль кладём в кэш напрямую: после действия старые id недействительны.
      const fresh = await getProfile();
      queryClient.setQueryData(["profile"], fresh);
    },
    onState: setState,
  })).current;
  const busy = state.pendingKey !== null;

  const item = (r: ItemRow, action: "revoke" | "restore", caption?: string) => (
    <View key={r.key} style={styles.row}>
      <View style={styles.labelWrap}>
        <Text style={[styles.label, action === "restore" && styles.removedLabel]}>{r.label}</Text>
        {caption ? <Text style={styles.caption}>{caption}</Text> : null}
        {state.errorKey === r.key && state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      </View>
      {state.pendingKey === r.key ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          hitSlop={8}
          onPress={() => { void actions.run(r, action); }}
        >
          <Text style={[styles.action, busy && styles.actionDisabled]}>{ITEM_ACTION_LABEL[r.kind][action]}</Text>
        </Pressable>
      )}
    </View>
  );
  const section = (title: string, list: ItemRow[]) => list.length > 0 && (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{title}</Text>
      {list.map((r) => item(r, "revoke", r.group))}
    </View>
  );

  return (
    <View style={styles.wrap}>
      {section("Что я умею", rows.capabilities)}
      {section("Ресурсы", rows.resources)}
      {section("Ограничения", rows.restrictions)}
      {rows.removed.length > 0 && (
        <View style={styles.section}>
          <Pressable accessibilityRole="button" onPress={() => setShowRemoved((v) => !v)} hitSlop={8}>
            <Text style={styles.sectionLabel}>{`Убранные (${rows.removed.length}) ${showRemoved ? "▴" : "▾"}`}</Text>
          </Pressable>
          {showRemoved && rows.removed.map((r) => item(r, "restore", REMOVED_KIND_LABEL[r.kind]))}
        </View>
      )}
      {state.error && !state.errorKey ? <Text style={styles.error}>{state.error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  section: { gap: spacing.xs },
  sectionLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingVertical: 4 },
  labelWrap: { flex: 1, gap: 2 },
  label: { ...typography.body, color: colors.textPrimary },
  removedLabel: { color: colors.textSecondary },
  caption: { ...typography.caption, color: colors.textSecondary },
  action: { ...typography.caption, color: colors.primary, fontWeight: "600" },
  actionDisabled: { color: colors.textSecondary },
  error: { ...typography.caption, color: colors.danger },
});
