import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { ToolError } from "../errors/tool-error";

// Use the SDK's native image source representation; never download caller URLs.
export function imageBlock(url: string): ImageBlockParam {
    if (url.startsWith("data:")) {
        const match =
            /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
                url,
            );
        if (!match || match[2].length % 4 !== 0)
            throw new ToolError(
                "Use a base64 JPEG, PNG, GIF or WebP image data URL",
            );
        const bytes = Buffer.from(match[2], "base64");
        if (!bytes.length || bytes.toString("base64") !== match[2])
            throw new ToolError("Invalid image base64");
        if (bytes.length > 5 * 1024 * 1024)
            throw new ToolError("Image exceeds the 5 MiB limit", 413);
        return {
            type: "image",
            source: {
                type: "base64",
                media_type: match[1] as
                    | "image/png"
                    | "image/jpeg"
                    | "image/gif"
                    | "image/webp",
                data: match[2],
            },
        };
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new ToolError("Invalid image URL");
    }
    if (
        !["https:", "http:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
    ) {
        throw new ToolError(
            "Image URLs must use HTTP(S) without embedded credentials",
        );
    }
    return { type: "image", source: { type: "url", url } };
}
