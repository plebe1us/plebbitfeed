import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const md = new MarkdownIt();

function escapeMarkdownV2(text: string): string {
    const escapeChars = [
        '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'
    ];
    let escapedText = text;
    escapeChars.forEach(char => {
        const escapedChar = '\\' + char;
        escapedText = escapedText.split(char).join(escapedChar);
    });
    return escapedText;
}

function sanitizeMarkdown(content: string): string {
    // Sanitize HTML tags
    const sanitizedContent = sanitizeHtml(content, {
        allowedTags: [],
        allowedAttributes: {}
    });
    // Render Markdown content
    const renderedContent = md.renderInline(sanitizedContent);
    // Escape characters for MarkdownV2
    return escapeMarkdownV2(renderedContent);
}

export {
    sanitizeMarkdown,
};
