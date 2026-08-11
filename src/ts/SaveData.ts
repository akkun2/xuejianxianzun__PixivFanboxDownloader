import { filter } from './Filter'
import { store } from './Store'
import { CommonResult, FileResult, ResultMeta } from './StoreType'
import {
  ServiceProvider,
  VideoProvider,
  PostBody,
  ImageData,
  FileData,
} from './CrawlResult'
import { settings } from './setting/Settings'
import { log } from './Log'
import { lang } from './Lang'
import { msgBox } from './MsgBox'
import { fileName } from './FileName'

type Dict = {
  [key in ServiceProvider]: string
}

type EmbedDataArr = [ServiceProvider | VideoProvider, string][]

class SaveData {
  // 嵌入的文件只支持指定的网站，每个网站有固定的前缀
  private readonly providerDict: Dict = {
    youtube: 'https://www.youtube.com/watch?v=',
    fanbox: 'https://www.fanbox.cc/',
    gist: 'https://gist.github.com/',
    soundcloud: 'https://soundcloud.com/',
    vimeo: 'https://player.vimeo.com/video/',
    twitter: 'https://twitter.com/i/web/status/',
    google_forms: 'https://docs.google.com/forms/d/e/',
  }

  private readonly extractTextReg = new RegExp(/<[^<>]+>/g)

  protected readonly matchImgSrc = new RegExp(
    /(?<=src=")https.*?(jpeg|jpg|png|gif|bmp)/g,
  )

  public receive(data: PostBody) {
    // console.log(data)
    this.parsePost(data)
  }

  private parsePost(data: PostBody) {
    // 针对投稿进行检查，决定是否保留它
    const id = data.id
    const creatorId = data.creatorId
    const fee = data.feeRequired
    const date = data.publishedDatetime
    const title = data.title
    const check = filter.check({ id, creatorId, fee, date, title })
    if (!check) {
      return
    }

    // 如果投稿检查通过，保存投稿信息
    const result: ResultMeta = {
      postId: data.id,
      type: data.type,
      title: data.title,
      date,
      fee,
      user: data.user.name,
      uid: data.user.userId,
      createID: data.creatorId,
      tags: data.tags.join(','),
      files: [],
      textContent: {
        fileID: '',
        name: 'links-' + data.id,
        ext: 'txt',
        size: null,
        index: 0,
        text: [],
        url: '',
        retryUrl: null,
      },
    }

    // 提取它的资源文件，并对每个资源进行检查，决定是否保存

    let index = 0 // 资源的序号
    // 封面图和文本资源的序号是 0，其他文件的序号自增

    // 提取投稿的封面图片
    // 封面图片的序号设置为 0，所以它里面不需要对 index 进行操作
    if (settings.savePostCover) {
      // 移除这部分路径，得到的就是缩略图的原图链接
      const cover = data.coverImageUrl?.replace('/c/1200x630_90_a2_g5', '')
      if (cover) {
        const { name, ext } = this.getUrlNameAndExt(cover)
        const r: FileResult = {
          fileID: this.createFileId(),
          name,
          ext,
          size: null,
          index,
          url: cover,
          retryUrl: null,
        }
        result.files.push(r)
      }
    }

    // 对于因为价格限制不能抓取文章，在此时返回，但是会保存封面图
    if (data.body === null) {
      store.skipDueToFee++
      log.warning(
        lang.transl(
          '_跳过文章因为',
          `<a href="https://www.fanbox.cc/@${creatorId}/posts/${id}" target="_blank">${title}</a>`,
        ) +
          lang.transl('_价格限制') +
          ` ${fee}`,
      )
      if (result.files.length > 0) {
        store.addResult(result)
      }
      return
    }

    // 非 article 投稿都有 text 字段，这这里统一提取里面的链接
    // 但是因为正则没有分组，所以非 article 投稿中如果有多个链接，可能会有遗漏，待考
    // 提取文本中的链接有两种来源，一种是文章正文里的文本，一种是嵌入资源。先从正文提取链接，后提取嵌入资源的链接。这样链接保存下来的顺序比较合理。
    if (data.type !== 'article') {
      let text = ''
      if (data.type === 'entry') {
        text = data.body.html.replace(this.extractTextReg, '')
      } else {
        text = data.body.text
      }
      if (text) {
        const links = this.getTextLinks(text)
        result.textContent.text = result.textContent.text.concat(links)
        result.textContent.fileID = this.createFileId()

        // 保存文章正文里的文字
        if (settings.saveText) {
          result.textContent.text.push(text)
        }
      }
    }

    // 提取 article 投稿的资源
    if (data.type === 'article') {
      let linkTexts: string[] = []
      let text = '' // 正文文本

      for (const block of data.body.blocks) {
        if (block.type === 'p' || block.type === 'header') {
          // 保存正文里的链接
          // 文本里也可能有链接，稍后会尝试提取链接
          block.text && linkTexts.push(block.text)

          if (block.links && block.links.length > 0) {
            // 保存链接
            for (const links of block.links) {
              linkTexts.push(links.url)
            }
          }

          // 保存正文里的文字
          if (block.text) {
            if (block.type === 'p') {
              // 在每个段落后面添加换行
              text += block.text + '\r\n'
            } else if (block.type === 'header') {
              // 对于标题文本，在其前后添加换行，以便和其他文本之间留出一定空白
              text += `\r\n${block.text}\r\n\r\n`
            }
          } else if (block.text === '') {
            // 空字符串在网页上渲染出来的表现是一个额外的空行，用于隔开段落。所以这里额外添加一个换行
            text += '\r\n'
          }
        }
      }

      for (const link of linkTexts) {
        const links = this.getTextLinks(link)
        result.textContent.text = result.textContent.text.concat(links)
        result.textContent.fileID = this.createFileId()
      }

      // 如果有链接，则添加一个空字符串，使其占据一行
      // 这样可以让链接和下面的正文部分之间有一个空行
      if (result.textContent.text.length > 0) {
        result.textContent.text.push('')
      }

      if (settings.saveText && text) {
        result.textContent.text.push(text)
      }

      // 保存图片资源
      for (const block of data.body.blocks) {
        if (block.type === 'image') {
          const imageData = data.body.imageMap[block.imageId]
          if (!imageData) {
            continue
          }
          index++
          const resource = this.getImageData(imageData, index)
          resource !== null && result.files.push(resource)
        }
      }

      // 保存 file 资源
      for (const block of data.body.blocks) {
        if (block.type === 'file') {
          const fileData = data.body.fileMap[block.fileId]
          if (!fileData) {
            continue
          }
          index++
          const resource = this.getFileData(fileData, index)
          resource !== null && result.files.push(resource)
        }
      }

      // 保存嵌入的资源，只能保存到文本
      const embedDataArr: EmbedDataArr = []
      for (const [id, embedData] of Object.entries(data.body.embedMap)) {
        embedDataArr.push([embedData.serviceProvider, embedData.contentId])
      }
      const embedLinks = this.getEmbedLinks(embedDataArr, data.id)
      result.textContent.text = result.textContent.text.concat(embedLinks)
      result.textContent.fileID = this.createFileId()

      // 保存嵌入的 URL，只能保存到文本
      if (settings.saveLink) {
        const urlArr: string[] = []
        for (const val of Object.values(data.body.urlEmbedMap)) {
          if (val.type === 'default') {
            urlArr.push(val.url)
          } else if (val.type === 'html' || val.type === 'html.card') {
            // 尝试从 html 代码中提取 url
            const testURL = val.html.match('iframe src="(http.*)"')
            if (testURL && testURL.length > 1) {
              let url = testURL[1]
              // 对 Google Drive 的链接进行特殊处理，将其从转换后的嵌入网址还原为原始网址
              if (url.includes('preview?usp=embed_googleplus')) {
                url = url.replace(
                  'preview?usp=embed_googleplus',
                  'edit?usp=drive_link',
                )
              }
              if (url.includes('embeddedfolderview?id=')) {
                url = url
                  .replace('embeddedfolderview?id=', 'drive/folders/')
                  .replace('#list', '?usp=drive_link')
              }
              urlArr.push(url)
            } else {
              urlArr.push(val.html)
            }
          }
        }
        if (urlArr.length > 0) {
          result.textContent.text = result.textContent.text.concat(
            urlArr.join('\n\n'),
          )
          result.textContent.fileID = this.createFileId()
        }
      }
    }

    // 提取 image 投稿的资源
    if (data.type === 'image') {
      // 保存图片资源
      for (const imageData of data.body.images) {
        if (!imageData) {
          continue
        }
        index++
        const resource = this.getImageData(imageData, index)
        resource !== null && result.files.push(resource)
      }
    }

    // 提取 entry 投稿的图片资源
    // 不知道此类型投稿中是否有其他类型的资源
    if (data.type === 'entry') {
      const LinkList = data.body.html.match(/<a.*?>/g)
      if (LinkList) {
        for (const a of LinkList) {
          const matchUrl = a.match('https.*(jpeg|jpg|png|gif|bmp)')
          if (!matchUrl) {
            continue
          }
          // 组合出 imageData，添加到结果中
          index++
          const url = matchUrl[0]
          const { name, ext } = this.getUrlNameAndExt(url)

          let width = 0
          const widthMatch = a.match(/width="(\d*?)"/)
          if (widthMatch && widthMatch.length > 1) {
            width = parseInt(widthMatch[1])
          }

          let height = 0
          const heightMatch = a.match(/height="(\d*?)"/)
          if (heightMatch && heightMatch.length > 1) {
            height = parseInt(heightMatch[1])
          }

          const imageData: ImageData = {
            id: name,
            extension: ext,
            originalUrl: url,
            thumbnailUrl: url,
            width: width,
            height: height,
          }

          const resource = this.getImageData(imageData, index)
          resource !== null && result.files.push(resource)
        }
      }
    }

    // 提取 file 投稿的资源，也就是作者上传的附件
    if (data.type === 'file') {
      // 保存 file 资源
      for (const fileData of data.body.files) {
        if (!fileData) {
          continue
        }
        index++
        const resource = this.getFileData(fileData, index)
        resource !== null && result.files.push(resource)
      }
    }

    // 提取 video 投稿的资源，注意这里的 video 是引用的外部网站的链接，不是作者上传的附件
    // video 数据保存到文本
    if (data.type === 'video') {
      const video = data.body.video
      const embedDataArr: EmbedDataArr = [
        [video.serviceProvider, video.videoId],
      ]
      const embedLinks = this.getEmbedLinks(embedDataArr, data.id)
      result.textContent.text = result.textContent.text.concat(embedLinks)
      result.textContent.fileID = this.createFileId()
    }

    if (settings.saveText && settings.textFormat === 'html') {
      result.textContent.ext = 'html'
      result.textContent.htmlData = data
      result.textContent.fileID ||= this.createFileId()
    }

    if (
      result.textContent.ext === 'txt' &&
      result.textContent.text.length > 0
    ) {
      const findURL = result.textContent.text.some((text) =>
        /https?:\/\//.test(text),
      )
      if (findURL) {
        msgBox.once('tipLinktext', lang.transl('_提示有外链保存到txt'))
      }
    }

    store.addResult(result)
  }

  public createHtmlDocument(data: PostBody, result: ResultMeta) {
    const postUrl = `https://www.fanbox.cc/@${encodeURIComponent(
      data.creatorId,
    )}/posts/${encodeURIComponent(data.id)}`
    const safePostUrl = this.getSafeExternalUrl(postUrl)!
    const commonResult = this.getCommonResult(result)
    const htmlPath = fileName.getFileName({
      ...commonResult,
      ...result.textContent,
    })
    let coverHtml = ''
    let body = ''

    const cover = result.files.find((file) => file.index === 0)

    if (data.body) {
      if (data.type === 'article') {
        body = data.body.blocks
          .map((block) => {
            if (block.type === 'p' || block.type === 'header') {
              const tag = block.type === 'header' ? 'h2' : 'p'
              return `<${tag}>${this.renderInlineText(
                block.text,
                block.styles || [],
                block.links || [],
              )}</${tag}>`
            }

            if (block.type === 'image') {
              const image = data.body!.imageMap[block.imageId]
              if (!image) {
                return ''
              }
              return this.renderPostImage(image, result, commonResult, htmlPath)
            }

            if (block.type === 'file') {
              const file = data.body!.fileMap[block.fileId]
              if (!file) {
                return ''
              }
              return this.renderPostFile(
                file.url,
                `${file.name}.${file.extension}`,
                file.id,
                result,
                commonResult,
                htmlPath,
              )
            }

            if (block.type === 'embed') {
              const embed = data.body!.embedMap[block.embedId]
              if (!embed) {
                return ''
              }
              const url = this.getEmbedUrl(
                embed.serviceProvider,
                embed.contentId,
              )
              return this.renderExternalLink(url, url, 'embed')
            }

            if (block.type !== 'url_embed' || !settings.saveLink) {
              return ''
            }
            const urlEmbed = data.body!.urlEmbedMap[block.urlEmbedId]
            if (!urlEmbed) {
              return ''
            }

            let url = ''
            if (urlEmbed.type === 'default') {
              url = urlEmbed.url
            } else if (
              urlEmbed.type === 'html' ||
              urlEmbed.type === 'html.card'
            ) {
              const matchedUrl = urlEmbed.html.match('iframe src="(http.*)"')
              if (matchedUrl && matchedUrl.length > 1) {
                url = matchedUrl[1]
                if (url.includes('preview?usp=embed_googleplus')) {
                  url = url.replace(
                    'preview?usp=embed_googleplus',
                    'edit?usp=drive_link',
                  )
                }
                if (url.includes('embeddedfolderview?id=')) {
                  url = url
                    .replace('embeddedfolderview?id=', 'drive/folders/')
                    .replace('#list', '?usp=drive_link')
                }
              }
            } else if (urlEmbed.type === 'fanbox.post') {
              url = `https://www.fanbox.cc/@${encodeURIComponent(
                urlEmbed.postInfo.creatorId,
              )}/posts/${encodeURIComponent(urlEmbed.postInfo.id)}`
            }
            return this.renderExternalLink(url, url, 'embed')
          })
          .join('\n')
      } else if (data.type === 'entry') {
        body = this.sanitizeEntryHtml(
          data.body.html,
          result,
          commonResult,
          htmlPath,
        )
      } else {
        body = this.textToHtml(data.body.text)

        if (data.type === 'image') {
          body += data.body.images
            .map((image) =>
              this.renderPostImage(image, result, commonResult, htmlPath),
            )
            .join('\n')
        } else if (data.type === 'file') {
          body += data.body.files
            .map((file) =>
              this.renderPostFile(
                file.url,
                `${file.name}.${file.extension}`,
                file.id,
                result,
                commonResult,
                htmlPath,
              ),
            )
            .join('\n')
        } else if (data.type === 'video') {
          const url = this.getEmbedUrl(
            data.body.video.serviceProvider,
            data.body.video.videoId,
          )
          body += this.renderExternalLink(url, url, 'embed')
        }
      }
    }

    if (cover) {
      const coverPath = fileName.getFileName({
        ...commonResult,
        ...cover,
      })
      const relativeCoverPath = this.getRelativePath(htmlPath, coverPath)
      if (!body.includes(relativeCoverPath)) {
        coverHtml = this.renderImageSource(relativeCoverPath, cover.name)
      }
    }

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' https: http:; style-src 'unsafe-inline'; script-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none';">
<title>${this.escapeHtml(data.title)}</title>
<style>body{max-width:800px;margin:0 auto;padding:24px;font-family:Arial,sans-serif;line-height:1.7;color:#222;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#06c}figure{margin:1.5em 0}h1{line-height:1.3}.meta{color:#666;font-size:.9em}</style>
</head>
<body>
<header><h1>${this.escapeHtml(data.title)}</h1><p class="meta"><a href="${this.escapeHtml(
      safePostUrl,
    )}" rel="noopener noreferrer">${this.escapeHtml(safePostUrl)}</a></p></header>
<main>${coverHtml}${body}</main>
</body>
</html>`
  }

  private renderInlineText(
    text: string,
    styles: { type: 'bold'; offset: number; length: number }[],
    links: { offset: number; length: number; url: string }[],
  ) {
    const boundaries = new Set<number>([0, text.length])
    const ranges = [...styles, ...links]
    for (const range of ranges) {
      boundaries.add(Math.max(0, Math.min(text.length, range.offset)))
      boundaries.add(
        Math.max(0, Math.min(text.length, range.offset + range.length)),
      )
    }

    const points = [...boundaries].sort((a, b) => a - b)
    let html = ''
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i]
      const end = points[i + 1]
      let part = this.escapeHtml(text.slice(start, end))
      const bold = styles.some(
        (style) => start >= style.offset && end <= style.offset + style.length,
      )
      const link = links.find(
        (item) => start >= item.offset && end <= item.offset + item.length,
      )
      if (bold) {
        part = `<strong>${part}</strong>`
      }
      const url = link && this.getSafeExternalUrl(link.url)
      if (url) {
        part = `<a href="${this.escapeHtml(
          url,
        )}" rel="noopener noreferrer">${part}</a>`
      }
      html += part
    }
    return html
  }

  private getSafeExternalUrl(value: string) {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.href
        : null
    } catch {
      return null
    }
  }

  private getCommonResult(result: ResultMeta): CommonResult {
    return {
      postId: result.postId,
      type: result.type,
      title: result.title,
      date: result.date,
      fee: result.fee,
      user: result.user,
      uid: result.uid,
      createID: result.createID,
      tags: result.tags,
    }
  }

  private renderPostImage(
    image: ImageData,
    result: ResultMeta,
    commonResult: CommonResult,
    htmlPath: string,
  ) {
    const downloadedImage = result.files.find(
      (file) => file.fileID === image.id,
    )
    if (downloadedImage) {
      const imagePath = fileName.getFileName({
        ...commonResult,
        ...downloadedImage,
      })
      return this.renderImageSource(
        this.getRelativePath(htmlPath, imagePath),
        image.id,
      )
    }

    return this.renderImage(
      image[settings.imageSize === 'original' ? 'originalUrl' : 'thumbnailUrl'],
      image.id,
    )
  }

  private getRelativePath(fromFile: string, toFile: string) {
    const from = fromFile.replace(/\\/g, '/').split('/')
    const to = toFile.replace(/\\/g, '/').split('/')
    from.pop()

    while (from.length > 0 && to.length > 0 && from[0] === to[0]) {
      from.shift()
      to.shift()
    }

    return [
      ...from.map(() => '..'),
      ...to.map((segment) => encodeURIComponent(segment)),
    ].join('/')
  }

  private renderImage(src: string, alt: string) {
    const safeSrc = this.getSafeExternalUrl(src)
    return safeSrc ? this.renderImageSource(safeSrc, alt) : ''
  }

  private renderImageSource(src: string, alt: string) {
    return `<figure><img src="${this.escapeHtml(src)}" alt="${this.escapeHtml(
      alt,
    )}"></figure>`
  }

  private renderExternalLink(
    url: string,
    text: string,
    className: string,
    local: boolean = false,
  ) {
    const safeUrl = this.getSafeExternalUrl(url)
    const content = this.escapeHtml(text)
    if (local) {
      return `<p class="${className}"><a href="${this.escapeHtml(
        url,
      )}" rel="noopener noreferrer">${content}</a></p>`
    }
    return safeUrl
      ? `<p class="${className}"><a href="${this.escapeHtml(
          safeUrl,
        )}" rel="noopener noreferrer">${content}</a></p>`
      : content
        ? `<p class="${className}">${content}</p>`
        : ''
  }

  private renderPostFile(
    url: string,
    text: string,
    fileId: string,
    result: ResultMeta,
    commonResult: CommonResult,
    htmlPath: string,
  ) {
    const downloadedFile = result.files.find((file) => file.fileID === fileId)
    if (downloadedFile) {
      const filePath = fileName.getFileName({
        ...commonResult,
        ...downloadedFile,
      })
      return this.renderExternalLink(
        this.getRelativePath(htmlPath, filePath),
        text,
        'attachment',
        true,
      )
    }
    return this.renderExternalLink(url, text, 'attachment')
  }

  private textToHtml(text: string) {
    return text
      .split(/\r?\n/)
      .map((line) => `<p>${this.escapeHtml(line) || '<br>'}</p>`)
      .join('\n')
  }

  private sanitizeEntryHtml(
    html: string,
    result: ResultMeta,
    commonResult: CommonResult,
    htmlPath: string,
  ) {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const allowedTags = new Set([
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'a',
      'img',
      'figure',
      'figcaption',
      'div',
      'span',
    ])
    const sanitizeNode = (node: Node) => {
      for (const child of [...node.childNodes]) {
        sanitizeNode(child)
      }
      if (!(node instanceof Element)) {
        return
      }

      const tag = node.tagName.toLowerCase()
      if (
        node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
        !allowedTags.has(tag)
      ) {
        node.replaceWith(...node.childNodes)
        return
      }

      const allowedAttributes =
        tag === 'a'
          ? new Set(['href', 'title'])
          : tag === 'img'
            ? new Set(['src', 'alt', 'title', 'width', 'height'])
            : new Set<string>()
      for (const attribute of [...node.attributes]) {
        if (!allowedAttributes.has(attribute.name.toLowerCase())) {
          node.removeAttribute(attribute.name)
        }
      }

      const urlAttribute = tag === 'a' ? 'href' : tag === 'img' ? 'src' : null
      if (urlAttribute && node.hasAttribute(urlAttribute)) {
        const sourceUrls = [node.getAttribute(urlAttribute)!]
        if (
          tag === 'img' &&
          node.parentElement?.tagName.toLowerCase() === 'a'
        ) {
          const href = node.parentElement.getAttribute('href')
          href && sourceUrls.push(href)
        }
        const downloadedImage =
          tag === 'img'
            ? result.files.find(
                (file) => file.fileID === this.getImageFileId(sourceUrls[0]),
              )
            : undefined
        if (downloadedImage) {
          const imagePath = fileName.getFileName({
            ...commonResult,
            ...downloadedImage,
          })
          node.setAttribute('src', this.getRelativePath(htmlPath, imagePath))
        } else {
          const url = this.getSafeExternalUrl(node.getAttribute(urlAttribute)!)
          if (url) {
            node.setAttribute(urlAttribute, url)
          } else {
            node.removeAttribute(urlAttribute)
          }
        }
      }
      if (tag === 'img' && node.hasAttribute('src')) {
        const src = node.getAttribute('src')!
        if (!src.startsWith('../') && !src.startsWith('./')) {
          const url = this.getSafeExternalUrl(src)
          if (url) {
            node.setAttribute('src', url)
          }
        }
      }
    }

    for (const child of [...document.body.childNodes]) {
      sanitizeNode(child)
    }
    return document.body.innerHTML
  }

  private escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (character) => {
      const entities: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }
      return entities[character]
    })
  }

  private getImageFileId(url: string) {
    try {
      const pathname = new URL(url).pathname
      const fileName = pathname.split('/').pop() || ''
      return fileName.split('.')[0]
    } catch {
      return ''
    }
  }

  private getEmbedUrl(
    serviceProvider: ServiceProvider | VideoProvider,
    contentId: string,
  ) {
    let url = this.providerDict[serviceProvider] + contentId
    if (serviceProvider === 'google_forms') {
      url += '/viewform'
    }
    return url
  }

  private getImageData(imageData: ImageData, index: number): FileResult | null {
    if (
      filter.check({
        ext: imageData.extension,
      })
    ) {
      return {
        fileID: imageData.id,
        name: imageData.id,
        ext: imageData.extension,
        size: null,
        index,
        url: imageData[
          settings.imageSize === 'original' ? 'originalUrl' : 'thumbnailUrl'
        ],
        retryUrl: imageData.thumbnailUrl,
      }
    }

    return null
  }

  private getFileData(fileData: FileData, index: number): FileResult | null {
    if (
      filter.check({
        ext: fileData.extension,
        name: fileData.name,
      })
    ) {
      return {
        fileID: fileData.id,
        name: fileData.name,
        ext: fileData.extension,
        size: fileData.size,
        index,
        url: fileData.url,
        retryUrl: null,
      }
    }

    return null
  }

  // 从文本里提取链接
  private getTextLinks(text: string) {
    const links: string[] = []

    if (!settings.saveLink) {
      return links
    }

    // 一个段落里可能包含多个链接（啊好麻烦），所以用换行符来尝试分割一下
    const textArray = text.split('\n')
    const Reg = /http[s]*:\/\/[\w=\?\.\/&\-\#\!\%]+/g
    for (const str of textArray) {
      const match = Reg.exec(str)
      Reg.lastIndex = 0
      if (match && match.length > 0) {
        for (const link of match) {
          links.push(link)
        }
      }
    }

    return links
  }

  // 从嵌入的资源里，获取资源的原网址
  private getEmbedLinks(dataArr: EmbedDataArr, postId: string) {
    const links: string[] = []

    if (!settings.saveLink) {
      return links
    }

    for (const data of dataArr) {
      const [serviceProvider, contentId] = data
      links.push(this.getEmbedUrl(serviceProvider, contentId))
    }

    return links
  }

  // 下载器自己生成的 txt 文件没有 id，所以这里需要自己给它生成一个 id
  // 使用时间戳并不保险，因为有时候代码执行太快，会生成重复的时间戳。所以后面加上随机字符
  private createFileId() {
    return (
      new Date().getTime().toString() +
      Math.random().toString(16).replace('.', '')
    )
  }

  // 传入文件 url，提取文件名和扩展名
  private getUrlNameAndExt(url: string): {
    name: string
    ext: string
  } {
    const split = url.split('/')
    const fileName = split[split.length - 1]
    const name = fileName.split('.')[0]
    const ext = fileName.split('.')[1]
    return {
      name,
      ext,
    }
  }
}

const saveData = new SaveData()
export { saveData }
