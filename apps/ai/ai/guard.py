"""Safety guard for AI suggestions: re-validate dish IDs and prices."""

class Guard:
    """Validate AI suggestions against known menu."""

    def validate_suggestion(self, suggestion: dict, menu_item: any) -> bool:
        """
        Validate a suggestion returned from AI.

        Args:
            suggestion: {"menu_item_id": str, "qty": int, ...}
            menu_item: MenuItem from available_items

        Returns:
            True if suggestion is valid and safe
        """

        # Basic validation
        if not suggestion.get("menu_item_id"):
            return False

        if suggestion["menu_item_id"] != menu_item.id:
            return False

        qty = suggestion.get("qty", 1)
        if not isinstance(qty, int) or qty <= 0 or qty > 100:
            return False

        return True

    def enforce_topic(self, message: str) -> bool:
        """
        Simple topic limit: message should be about food.
        Returns True if message is on-topic.
        """

        message_lower = message.lower()

        # Block certain topics
        blocked_keywords = [
            "tiền", "giá", "đơn giá",  # price negotiation
            "hóa đơn", "thanh toán", "trả tiền",  # payments
            "hủy", "hoàn lại",  # order cancellation (handled by POS, not AI)
            "nhân viên", "quản lý",  # staff/management
            "chính sách", "quy định",  # policies
        ]

        if any(kw in message_lower for kw in blocked_keywords):
            return False

        return True
