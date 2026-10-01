"""Rule-based menu suggester (fallback when LLM unavailable)."""

import re
from typing import Tuple, Optional
from pydantic import BaseModel

class RuleSuggester:
    """Rule-based suggester for menu items based on keywords and tags."""

    def suggest(self, message: str, menu_items: list) -> Tuple[str, list]:
        """
        Suggest menu items based on keywords in the message.
        Returns: (reply_text, [{"menu_item_id": str, "qty": int}])
        """

        message_lower = message.lower()

        # Keyword-based matching
        keywords = {
            "phở": ["phở"],
            "cơm": ["cơm"],
            "canh": ["canh", "súp"],
            "gà": ["gà", "thịt gà"],
            "tôm": ["tôm"],
            "cá": ["cá", "tôm cá"],
            "nước": ["nước", "sinh tố", "chè"],
            "rau": ["rau", "salad", "gỏi"],
            "hot": ["nóng"],
            "lạnh": ["lạnh", "đá"],
        }

        matched = []
        for item in menu_items:
            score = 0
            item_name_lower = item.name.lower()
            item_tags = [t.lower() for t in item.tags]

            # Exact word match in name
            if any(kw in item_name_lower for group in keywords.values() for kw in group):
                score += 2

            # Tag match
            for tag in item_tags:
                if any(kw in tag for group in keywords.values() for kw in group):
                    score += 1

            if score > 0:
                matched.append((item, score))

        # Sort by score descending, return top 3
        matched.sort(key=lambda x: x[1], reverse=True)
        top_items = matched[:3]

        if top_items:
            reply = "Gợi ý cho bạn:\n" + "\n".join(
                f"- {item.name} ({item.price}₫)"
                for item, _ in top_items
            )
            suggestions = [
                {"menu_item_id": item.id, "qty": 1}
                for item, _ in top_items
            ]
        else:
            reply = "Không tìm thấy gợi ý phù hợp. Bạn muốn thử cái gì?"
            suggestions = []

        return reply, suggestions
