import { CommentData, PostBody } from './CrawlResult'
import { lang } from './Lang'
import { settings } from './setting/Settings'
import { ResultMeta } from './StoreType'
import { DateFormat } from './utils/DateFormat'
import { Tools } from './Tools'

class RenderCommentsText {
  private readonly extractTextReg = new RegExp(/<[^<>]+>/g)

  // 把评论转换为纯文本，添加到文本内容里
  public render(result: ResultMeta, data: PostBody) {
    if (!settings.saveComment) {
      return
    }
    // 评论会在 HTML 文档中渲染的前提：正文存在且正文以 HTML 格式保存
    // 对于正文受价格限制的投稿不会生成 HTML，评论仍以纯文本保存
    if (data.body && settings.saveText && settings.textFormat === 'html') {
      return
    }
    if (!data.commentList || data.commentList.items.length === 0) {
      return
    }

    const commentLines = this.getCommentLines(data.commentList.items)
    if (commentLines.length === 0) {
      return
    }

    // 在评论之前添加一个空行，与正文分隔开
    if (result.textContent.text.length > 0) {
      result.textContent.text.push('')
    }

    // 在正文与评论区之间添加分隔符，没有评论时不添加
    const commentsSeparator = `${lang.transl('_评论')}\r\n---\r\n`
    result.textContent.text.push(commentsSeparator)
    result.textContent.text = result.textContent.text.concat(commentLines)
    result.textContent.fileID ||= Tools.createFileId()
  }

  // 把评论数据转换为纯文本的多行文本
  private getCommentLines(comments: CommentData[]): string[] {
    const lines: string[] = []
    const roots = this.buildCommentTree(comments)
    for (const comment of roots) {
      this.commentToLines(comment, 0, lines)
    }
    return lines
  }

  // 把一条评论转换为文本行。回复会缩进显示
  private commentToLines(comment: CommentData, depth: number, lines: string[]) {
    const indent = '  '.repeat(depth)
    const user = comment.user ? comment.user.name : ''
    const body = (comment.body || '')
      .replace(this.extractTextReg, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    lines.push(
      `${indent}${user} (${DateFormat.format(
        comment.createdDatetime,
        'YYYY-MM-DD hh:mm:ss',
      )})`,
    )
    if (body) {
      for (const line of body.split(/\r?\n/)) {
        lines.push(indent + line)
      }
    }
    lines.push('')
    for (const reply of comment.replies) {
      this.commentToLines(reply, depth + 1, lines)
    }
  }

  private flattenComments(comments: CommentData[]): CommentData[] {
    const flat: CommentData[] = []
    const seen = new Set<string>()
    const walk = (list: CommentData[]) => {
      for (const comment of list) {
        if (!seen.has(comment.id)) {
          seen.add(comment.id)
          flat.push(comment)
        }
        if (comment.replies && comment.replies.length > 0) {
          walk(comment.replies)
        }
      }
    }
    walk(comments)
    return flat
  }

  private buildCommentTree(comments: CommentData[]): CommentData[] {
    const map = new Map<string, CommentData>()
    for (const comment of this.flattenComments(comments)) {
      map.set(comment.id, { ...comment, replies: [] })
    }

    const roots: CommentData[] = []
    for (const comment of map.values()) {
      if (comment.parentCommentId && map.has(comment.parentCommentId)) {
        map.get(comment.parentCommentId)!.replies.push(comment)
      } else {
        roots.push(comment)
      }
    }
    return roots
  }
}

const renderCommentsText = new RenderCommentsText()
export { renderCommentsText }
