"""AI Food Assistant — FastAPI service for menu suggestions & chat."""

import os
import json
from typing import Optional
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from dotenv import load_dotenv

# Load env vars
load_dotenv()

# Placeholder for LLM client (Anthropic)
try:
    import anthropic
    HAS_ANTHROPIC = bool(os.getenv("ANTHROPIC_API_KEY"))
except ImportError:
    HAS_ANTHROPIC = False

# Import local modules
from ai.rules import RuleSuggester
from ai.guard import Guard

# FastAPI app
app = FastAPI(title="Nha Hang Sen AI", version="0.1.0")

# Global instances
rule_suggester = RuleSuggester()
guard = Guard()
anthropic_client = anthropic.Anthropic() if HAS_ANTHROPIC else None

# ============ Models ============

class MenuItem(BaseModel):
    id: str
    name: str
    price: int
    tags: list[str] = []
    available: bool = True

class ChatRequest(BaseModel):
    message: str
    session_id: str
    history: list[dict] = []
    menu: list[MenuItem]

class SuggestedItem(BaseModel):
    menu_item_id: str
    qty: int

class ChatResponse(BaseModel):
    reply: str
    suggestions: list[SuggestedItem] = []

# ============ Endpoints ============

@app.get("/health")
def health():
    return {
        "status": "ok",
        "ai_enabled": HAS_ANTHROPIC and anthropic_client is not None,
        "model": os.getenv("AI_MODEL", "claude-3-5-sonnet-20241022"),
    }

@app.post("/chat")
async def chat(req: ChatRequest) -> ChatResponse:
    """
    Chat endpoint for AI Food Assistant.

    Tries LLM if available, falls back to rule-based suggester.
    Re-validates dish IDs and prices against menu.
    """

    # Build available menu for context
    available_items = {m.id: m for m in req.menu if m.available}
    if not available_items:
        return ChatResponse(reply="Xin lỗi, không có món nào còn hàng để gợi ý lúc này.", suggestions=[])

    menu_text = "\n".join([
        f"- {m.name} ({m.price}₫): tags {', '.join(m.tags)}"
        for m in req.menu if m.available
    ])

    suggestions = []

    # Try LLM if enabled
    if HAS_ANTHROPIC and anthropic_client:
        try:
            reply = _call_llm_with_tools(
                message=req.message,
                menu_context=menu_text,
                available_items=available_items,
            )
            suggestions = reply.get("suggestions", [])
        except Exception as e:
            # LLM error: log and fallback
            print(f"LLM error: {e}, falling back to rules")
            reply, rule_suggestions = rule_suggester.suggest(
                req.message, list(available_items.values())
            )
            suggestions = rule_suggestions
    else:
        # No LLM: rule-based only
        reply, rule_suggestions = rule_suggester.suggest(
            req.message, list(available_items.values())
        )
        suggestions = rule_suggestions

    # Re-validate suggestions against menu
    validated = []
    for sug in suggestions:
        if sug["menu_item_id"] in available_items:
            item = available_items[sug["menu_item_id"]]
            # Guard: check price/id match
            if guard.validate_suggestion(sug, item):
                validated.append(SuggestedItem(
                    menu_item_id=sug["menu_item_id"],
                    qty=sug.get("qty", 1),
                ))

    return ChatResponse(reply=reply, suggestions=validated)

def _call_llm_with_tools(
    message: str,
    menu_context: str,
    available_items: dict,
) -> dict:
    """
    Call Anthropic Claude with tool use for menu search and suggestions.
    Returns {"reply": str, "suggestions": [{"menu_item_id": str, "qty": int}]}
    """

    tools = [
        {
            "name": "search_menu",
            "description": "Search menu items by name or tag",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search term"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "suggest_item",
            "description": "Suggest a menu item to add to cart",
            "input_schema": {
                "type": "object",
                "properties": {
                    "menu_item_id": {"type": "string"},
                    "qty": {"type": "integer", "minimum": 1},
                },
                "required": ["menu_item_id", "qty"],
            },
        },
    ]

    system_prompt = f"""You are a helpful Vietnamese restaurant food assistant for Nha Hang Sen.
Your role is to help guests discover and order delicious dishes.

Current menu (available):
{menu_context}

Rules:
1. Only suggest items from the menu above
2. Respond in Vietnamese
3. Be friendly and conversational
4. Use the search_menu tool to find relevant dishes
5. Use the suggest_item tool to recommend specific items
6. Never confirm orders or process payments

When the guest asks about food, use your tools to find and suggest matching dishes."""

    messages = [{"role": "user", "content": message}]
    if anthropic_client:
        # Simplified: just get text response, no tool loop for now
        response = anthropic_client.messages.create(
            model=os.getenv("AI_MODEL", "claude-3-5-sonnet-20241022"),
            max_tokens=256,
            system=system_prompt,
            messages=messages,
        )

        reply = response.content[0].text if response.content else "Xin lỗi, tôi không thể trả lời."
        return {"reply": reply, "suggestions": []}

    return {"reply": "AI không được bật.", "suggestions": []}

# ============ Startup ============

@app.on_event("startup")
async def startup():
    print(f"Nha Hang Sen AI starting... LLM={HAS_ANTHROPIC}")
