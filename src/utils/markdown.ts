import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const md = new MarkdownIt();

function escapeMarkdownV2(text: string): string {
    return text
        .replace(/\\/g, '\\\\')  // escape the backslash first
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/{/g, '\\{')
        .replace(/}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/!/g, '\\!');
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
