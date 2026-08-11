import { CommentData, PostBody } from './CrawlResult'
import { lang } from './Lang'
import { settings } from './setting/Settings'
import { Tools } from './Tools'
import { DateFormat } from './utils/DateFormat'

class RenderCommentsHtml {
  public async render(data: PostBody) {
    if (
      !settings.saveComment ||
      !data.commentList ||
      data.commentList.items.length === 0
    ) {
      return ''
    }

    const roots = this.buildCommentTree(data.commentList.items)
    const avatarMap = await this.fetchCommentAvatars(roots)
    const comments = roots
      .map((comment) => this.renderCommentHtml(comment, avatarMap))
      .join('\n')
    return `<section class="comments"><h2>${Tools.escapeHtml(
      lang.transl('_评论'),
    )}</h2>${comments}</section>`
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

  // 抓取评论者的头像，转换为 base64 data URL。失败的头像回退到原网址
  private async fetchCommentAvatars(comments: CommentData[]) {
    const map = new Map<string, string>()
    const seen = new Set<string>()
    await Promise.all(
      this.flattenComments(comments).map(async (comment) => {
        const url = comment.user && comment.user.iconUrl
        if (url && !seen.has(url)) {
          seen.add(url)
          const dataUrl = await this.fetchImageAsDataUrl(url)
          if (dataUrl) {
            map.set(url, dataUrl)
          }
        }
      }),
    )
    return map
  }

  private async fetchImageAsDataUrl(url: string): Promise<string | null> {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        return null
      }
      const blob = await response.blob()
      return await new Promise<string | null>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
    } catch {
      // 头像抓取失败时返回 null，渲染时回退到原网址
      return null
    }
  }

  private renderCommentHtml(
    comment: CommentData,
    avatarMap: Map<string, string>,
  ): string {
    const user = comment.user ? comment.user.name : ''
    let avatarUrl = comment.user
      ? avatarMap.get(comment.user.iconUrl) || comment.user.iconUrl
      : ''
    avatarUrl ||= this.noImageDataUrl
    const meta = `${Tools.escapeHtml(user)} · ${DateFormat.format(comment.createdDatetime, 'YYYY-MM-DD hh:mm:ss')}`
    const avatar = avatarUrl
      ? `<img class="comment-icon" src="${Tools.escapeHtml(
          avatarUrl,
        )}" alt="" loading="lazy">`
      : ''
    const body = Tools.escapeHtml(comment.body || '')
    const replies = comment.replies
      .map((reply) => this.renderCommentHtml(reply, avatarMap))
      .join('\n')
    return `<div class="comment">${avatar}<div class="comment-main"><p class="comment-meta">${meta}</p><div class="comment-body">${body}</div>${
      replies ? `<div class="comment-replies">${replies}</div>` : ''
    }</div></div>`
  }

  /** 用户没有自定义头像时显示的默认头像 */
  private readonly noImageDataUrl = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKoAAACqBAMAAADPWMmxAAAABGdBTUEAALGPC/xhBQAAAAFzUkdCAK7OHOkAAAAPUExURZ+zx9be5f///7bF1MbS3Ap7yAkAAAOZSURBVGje7ZsNjqwgDMcxeADnwQXeO0ENHkCi9z/T1vIhzoCI675kk5LdqCv85k8pbZlkxesnmvjz7/n295dRH7cqU5nKVKYylalMZSpTmcpUpjKVqUxl6n+m6mmytcHLYtuoi8AmT5kasMs45LoVqLOg1rsnlZUE1KWBqoRvIz1mRfs+cJ06B6obIERRat5QWaqOAwTNHfqMVUUrddj6unFdaa2oz7hcoS6TNqMzQOcG9u7P/s1i8Gk1xro+fbxoM5WpIGGbNPipk2Rn11ng+GUjaKfO93FP+m1Wb1Q36Z3mr3JfG2eYMbzTpHUOPQtUOSMi2ApSrfhGTJu+EU3TxT50ha2DLVOtFlIHe+6WwEGjwuE0dgHRxT7bVePt4H07T30l1Dmlbp+3wemz+pQqnZd1ZeqrqNVqMuBIe+qoVSX78FSrzFNxnrPoFN6ldsUBBsx4rjW/WkEr3ql9tbQzhzzbBU7rp2cdteIPad39Fb1jNa+KVj9ztdvuoJX+DG595kv+SlqPu/FNK6qTdIdtUiLurTJ12+e4o6nvtMSFxTig/BsMAXiLK6P2mEVxwNhqfN1HlBNMcyTco3ZXps6p1ktUXZfq+/QNWoPVxrMcq8A51WWtfkilINDr+mqjYqsWGcEO3eMV0fAw1ZUekLX+feogjKWiSNgHqVDeBE9Q+yepx/LmaWr3aK2tTiLFd/wVSyPDZ5hfRNXGNlGVuRAJNWQ3QZGq60Hbn7j6BuqW66q5AEpHvRLVxY7p9LxJzGzGLFFDlLNnubCYhwtUTac+uXFzh2S9OCZI0aZV7rWJmVabZlZjwlmTwI12lSJhS2yATSQNxA0foGEHzP4ZQWm+EilWGbvOD24AQikVnOwCSIVJguCFRMr4QuQOzic7FpwcmTfBbu+2XDB8ouDDALJQNZa/zYkqad6S5IHzUJAn32OcR0LYV/qkjY1UdbSgPDiFX0ApWqO29nMWUhyNkbauORcMbyuVSI3rZpupWrz5pkiNIUu7tZa3Zi8sGEAGH4hwe4OqC44fLdDfyrFz9KzUx0guebC9l7n9rKNCOHjAdLMeUKXZy/NvPCtVxpy4feT7XWvv1y6J378ZYPxGRaSzFpCVpF6ts/RHOKDf6ZvVm/bzhuANUIVeqgk/922tArtUaS5Hs9arxYv162LiQl2pQK9XxSvWLOt66XjPpw2mMpWpTGUqU5nKVKYylalMff26/4v7CerrJ9oXNlXWuxTC6UcAAAAASUVORK5CYII=`
}

const renderCommentsHtml = new RenderCommentsHtml()
export { renderCommentsHtml }
