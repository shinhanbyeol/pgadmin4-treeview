import * as React from 'react'
import {
    FileTree,
    Directory,
    FileEntry,
    ItemType,
    IFileTreeHandle,
    RenamePromptHandle,
    NewFilePromptHandle,
    WatchEvent,
    FileType,
    IItemRendererProps,
    FileOrDir
} from 'react-aspen'
import { Decoration, TargetMatchMode } from 'aspen-decorations'
import { FileTreeItem } from '../FileTreeItem'
import { Notificar, DisposablesComposite } from 'notificar'
import { IFileTreeXHandle, IFileTreeXProps, FileTreeXEvent, IFileTreeXTriggerEvents } from '../types'
import * as isValidFilename from 'valid-filename'
import { KeyboardHotkeys } from '../services/keyboardHotkeys'
import { showContextMenu } from '../services/contextMenu'
import { DragAndDropService } from '../services/dragAndDrop'
import { TreeModelX } from '../TreeModelX'
import AutoSizer from "react-virtualized-auto-sizer";

import '../css/styles.scss'

export class FileTreeX extends React.Component<IFileTreeXProps> {
    private fileTreeHandle: IFileTreeXHandle
    private activeFileDec: Decoration
    private pseudoActiveFileDec: Decoration
    private activeFile: FileOrDir
    private pseudoActiveFile: FileOrDir
    private wrapperRef: React.RefObject<HTMLDivElement> = React.createRef()
    private events: Notificar<FileTreeXEvent>
    private disposables: DisposablesComposite
    private keyboardHotkeys: KeyboardHotkeys
    private dndService: DragAndDropService
    private fileTreeEvent: IFileTreeXTriggerEvents
    constructor(props: IFileTreeXProps) {
        super(props)
        this.events = new Notificar()
        this.disposables = new DisposablesComposite()
        this.activeFileDec = new Decoration('active')
        this.pseudoActiveFileDec = new Decoration('pseudo-active')

        this.dndService = new DragAndDropService(this.props.model)
        this.dndService.onDragAndDrop(async (item: FileOrDir, newParent: Directory) => {
            try {
                const { model, mv } = this.props
                const newPath = model.root.pathfx.join(newParent.path, item.fileName)
                await mv(item.path, newPath)
                model.root.inotify({
                    type: WatchEvent.Moved,
                    oldPath: item.path,
                    newPath: newPath,
                })
            } catch (error) {
                // handle as you see fit
            }
        })
    }

    render() {
        const { height, width, model } = this.props
        const { decorations } = model

        return <div
            onKeyDown={this.handleKeyDown}
            className='file-tree'
            onBlur={this.handleBlur}
            onContextMenu={this.handleContextMenu}
            onClick={this.handleClick}
            ref={this.wrapperRef}
            style={{
              height: "calc(100vh - 60px)",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              flex: 1
            }}
            tabIndex={-1}>
            <AutoSizer onResize={this.onResize}>
            {({ width, height }) => (
            <FileTree
                height={height}
                width={width}
                model={model}
                itemHeight={FileTreeItem.renderHeight}
                onReady={this.handleTreeReady}
                >
                {(props: IItemRendererProps) => <FileTreeItem
                    item={props.item}
                    itemType={props.itemType}
                    decorations={decorations.getDecorations(props.item as any)}
                    dndService={this.dndService}
                    onClick={this.handleItemClicked}
                    onDoubleClick={this.handleItemDoubleClicked}
                    onContextMenu={this.handleItemCtxMenu}
                    changeDirectoryCount={this.changeDirectoryCount}
                    events={this.events}/>}
            </FileTree>
            )}
         </AutoSizer>
        </div>
    }

    public componentDidMount() {
        for(let child of this.props.model.root.children) {
            this.events.dispatch(FileTreeXEvent.onTreeEvents, window.event, 'loaded', child)
        }
	}

    componentWillUnmount() {
        const { model } = this.props
        model.decorations.removeDecoration(this.activeFileDec)
        model.decorations.removeDecoration(this.pseudoActiveFileDec)
        this.disposables.dispose()
    }

    private handleTreeEvent = (event: IFileTreeXTriggerEvents) => {
        this.fileTreeEvent = this.props.onEvent
    }

    private handleTreeReady = (handle: IFileTreeHandle) => {
        const { onReady, model } = this.props

        this.fileTreeHandle = {
            ...handle,
            getModel: () => this.props.model,
            getActiveFile: () => this.activeFile,
            setActiveFile: this.setActiveFile,
            getPseudoActiveFile: () => this.pseudoActiveFile,
            setPseudoActiveFile: this.setPseudoActiveFile,
            toggleDirectory: this.toggleDirectory,
            rename: async (fileOrDirOrPath: FileOrDir | string) => this.supervisePrompt(await handle.promptRename(fileOrDirOrPath as any)),
            remove: this.removeDir,
            newFile: async (dirOrPath: Directory | string) => this.supervisePrompt(await handle.promptNewFile(dirOrPath as any)),
            newFolder: async (dirOrPath: Directory | string) => this.supervisePrompt(await handle.promptNewDirectory(dirOrPath as any)),
            onBlur: (callback) => this.events.add(FileTreeXEvent.OnBlur, callback),
            hasDirectFocus: () => this.wrapperRef.current === document.activeElement,
            first: this.first,
            parent: this.parent,
            hasParent: this.hasParent,
            isOpen: this.isOpen,
            isClosed: this.isClosed,
            itemData: this.itemData,
            children: this.children,
            getItemFromDOM: this.getItemFromDOM,
            getDOMFromItem: this.getDOMFromItem,
            onTreeEvents: (callback) => this.events.add(FileTreeXEvent.onTreeEvents, callback),
            addIcon: this.addIcon,
            addCssClass: this.addCssClass,
            create: this.create,
            remove: this.remove,
            update: this.update,
            refresh: this.refresh,
            setLabel: this.setLabel,
            unload: this.unload,
            deSelectActiveFile: this.deSelectActiveFile,
            resize: this.resize
        }

        model.decorations.addDecoration(this.activeFileDec)
        model.decorations.addDecoration(this.pseudoActiveFileDec)

        this.disposables.add(this.fileTreeHandle.onDidChangeModel((prevModel: TreeModelX, newModel: TreeModelX) => {
            this.setActiveFile(null)
            this.setPseudoActiveFile(null)
            prevModel.decorations.removeDecoration(this.activeFileDec)
            prevModel.decorations.removeDecoration(this.pseudoActiveFileDec)
            newModel.decorations.addDecoration(this.activeFileDec)
            newModel.decorations.addDecoration(this.pseudoActiveFileDec)
        }))

        this.disposables.add(this.fileTreeHandle.onBlur(() => {
            this.setPseudoActiveFile(null)
        }))

        this.keyboardHotkeys = new KeyboardHotkeys(this.fileTreeHandle)

        if (typeof onReady === 'function') {
            onReady(this.fileTreeHandle)
        }
    }

    private setActiveFile = async (fileOrDirOrPath: FileOrDir | string, ensureVisible, align): Promise<void> => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === this.props.model.root) { return }
        if (this.activeFile !== fileH) {
            if (this.activeFile) {
                this.activeFileDec.removeTarget(this.activeFile)
            }
            if (fileH) {
                this.activeFileDec.addTarget(fileH as any, TargetMatchMode.Self)
            }
            this.activeFile = fileH
            this.events.dispatch(FileTreeXEvent.onTreeEvents, window.event, 'selected', fileH)

            if (fileH && ensureVisible === true) {
                const alignTree = align !== undefined && align !== null ? align : 'auto'
                await this.fileTreeHandle.ensureVisible(fileH, alignTree)
            }
        }
    }

    private ensureVisible = async (fileOrDirOrPath: FileOrDir | string): Promise<void> => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH) {
            await this.fileTreeHandle.ensureVisible(fileH)
        }
    }

    private deSelectActiveFile = async (fileOrDirOrPath: FileOrDir | string): Promise<void> => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === this.props.model.root) { return }
        if (this.activeFile === fileH) {
            this.activeFileDec.removeTarget(this.activeFile)
            this.activeFile = null
        }
    }

    private setPseudoActiveFile = async (fileOrDirOrPath: FileOrDir | string): Promise<void> => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === this.props.model.root) { return }
        if (this.pseudoActiveFile !== fileH) {
            if (this.pseudoActiveFile) {
                this.pseudoActiveFileDec.removeTarget(this.pseudoActiveFile)
            }
            if (fileH) {
                this.pseudoActiveFileDec.addTarget(fileH as any, TargetMatchMode.Self)
            }
            this.pseudoActiveFile = fileH
        }
        if (fileH) {
            await this.fileTreeHandle.ensureVisible(fileH)
        }
        this.events.dispatch(FileTreeXEvent.onTreeEvents, window.event, 'selected', fileH)
    }

    private create = async (parentDir, itemData): Promise<void> => {
        if (parentDir == undefined || parentDir == null) {
            parentDir = this.props.model.root
        }
        const {create, model } = this.props
        const isOpen = parentDir.isExpanded
        let maybeFile = undefined

        if (isOpen && (parentDir._children == null || parentDir._children.length == 0)) {
            await this.fileTreeHandle.closeDirectory(parentDir as Directory)
        }
        if (!parentDir.isExpanded && (parentDir._children == null || parentDir._children.length == 0)) {
            await this.fileTreeHandle.openDirectory(parentDir as Directory)
        } else {
            await this.fileTreeHandle.openDirectory(parentDir as Directory)
            maybeFile = await create(parentDir.path, itemData)
            if (maybeFile && maybeFile.type && maybeFile.name) {
                model.root.inotify({
                    type: WatchEvent.Added,
                    directory: parentDir.path,
                    file: maybeFile,
                })
            }
        }
        this.changeDirectoryCount(parentDir)
        let newItem = parentDir._children.find((c) => c._metadata.data.id === itemData.id)
        newItem.resolvedPathCache = newItem.parent.path + "/" + newItem._metadata.data.id
        return newItem
    }

    private update = async (item, itemData): Promise<void> => {
        item._metadata.data = itemData
        await this.props.update(item.path, itemData)
    }

     private refresh = async (item): Promise<void> => {
         const {remove, model } = this.props
         const isOpen = item.isExpanded
         if (item.children && item.children.length > 0) {
             for(let entry of item.children) {
                 await this.remove(entry).then(val => {}, error => {console.warn("Error removing item")})
             }
         }
         if (isOpen) {
             await this.fileTreeHandle.closeDirectory(item as Directory)
             await this.fileTreeHandle.openDirectory(item as Directory)
             await this.changeResolvePath(item as Directory)
             this.changeDirectoryCount(item)
         }
    }

    private unload = async (item): Promise<void> => {
         const {remove, model } = this.props
         const isOpen = item.isExpanded
         if (item.children && item.children.length > 0) {
             for(let entry of item.children) {
                 await this.remove(entry).then(val => {}, error => {console.warn(error)})
             }
         }
         if (isOpen) {
             await this.fileTreeHandle.closeDirectory(item as Directory)
             this.changeDirectoryCount(item)
         }
    }

    private remove = async (item): Promise<void> => {
        const {remove, model } = this.props
        const path = item.path
        await remove(path, false)
        const dirName = model.root.pathfx.dirname(path);
        const fileName = model.root.pathfx.basename(path);
        const parent = item.parent
        if (dirName === parent.path) {
            const item_1 = parent._children.find((c) => c._metadata && c._metadata.data.id === fileName);
            if (item_1) {
                parent.unlinkItem(item_1);
                if (parent._children.length == 0) { parent._children = null }
                this.changeDirectoryCount(parent)
                this.events.dispatch(FileTreeXEvent.onTreeEvents, window.event, 'removed', item)
            }
            else {
                console.warn("Item not found")
            }
        }
    }

    private first = async (fileOrDirOrPath: FileOrDir | string) => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === undefined || fileH === null) { return this.props.model.root.children[0] }

        if (fileH.branchSize > 0) {
            return fileH.children[0]
        }
        return null
    }

    private parent = async (fileOrDirOrPath: FileOrDir | string) => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === FileType.Directory || fileH === FileType.File) {
            return fileH.parent
        }

        return null
    }


    private hasParent = async (fileOrDirOrPath: FileOrDir | string) => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === FileType.Directory || fileH === FileType.File) {
            return fileH.parent ? true : false
        }

        return false
    }

    private children = async (fileOrDirOrPath: FileOrDir | string) => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === FileType.Directory) {
            return fileH.children
        }

        return null
    }


    private isOpen = async (fileOrDirOrPath: FileOrDir | string) => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === FileType.Directory) {
            return fileH.isExpanded
        }

        return false
    }

     private isClosed = async (fileOrDirOrPath: FileOrDir | string) => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === FileType.Directory || fileH === FileType.File) {
             return !fileH.isExpanded
        }

        return false
    }

    private itemData = async (fileOrDirOrPath: FileOrDir | string) => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === FileType.Directory || fileH === FileType.File) {
             return fileH._metadata.data
        }

        return null
    }

    private setLabel = async(pathOrDir: string | Directory, label: string): Promise<void> => {
        const dir = typeof pathOrDir === 'string'
            ? await this.fileTreeHandle.getFileHandle(pathOrDir)
            : pathOrDir

        const ref = FileTreeItem.itemIdToRefMap.get(dir.id);
        if (ref) {
            ref.style.background = 'none'
            const label$ = ref.querySelector('span.file-name') as HTMLDivElement

            if (label$) {
                if (typeof(label) == "object" && label.label) {
                    label = label.label
                }
                label$.innerHTML = label;
            }

        }

   }

    private changeDirectoryCount = async(pathOrDir: string | Directory): Promise<void> => {
        const dir = typeof pathOrDir === 'string'
            ? await this.fileTreeHandle.getFileHandle(pathOrDir)
            : pathOrDir

        if (dir.type === FileType.Directory && dir._metadata.data && dir._metadata.data.is_collection === true) {
            const ref = FileTreeItem.itemIdToRefMap.get(dir.id);
            if (ref) {
                ref.style.background = 'none'
                const label$ = ref.querySelector('span.children-count') as HTMLDivElement
                if(dir.children && dir.children.length > 0) {
                    label$.innerHTML = "(" + dir.children.length + ")";
                } else {
                    label$.innerHTML = "";
                }
            }
        }

   }

    private toggleDirectory = async (pathOrDir: string | Directory) => {
        const dir = typeof pathOrDir === 'string'
            ? await this.fileTreeHandle.getFileHandle(pathOrDir)
            : pathOrDir

        if (dir.type === FileType.Directory) {
            if ((dir as Directory).expanded) {
                this.fileTreeHandle.closeDirectory(dir as Directory)
                this.events.dispatch(FileTreeXEvent.onTreeEvents, window.event, 'closed', dir)

            } else {
                const ref = FileTreeItem.itemIdToRefMap.get(dir.id);
                if (ref) {
                    ref.style.background = 'none'
                    const label$ = ref.querySelector('i.directory-toggle') as HTMLDivElement
                    label$.classList.add("loading");
                }

                await this.events.dispatch(FileTreeXEvent.onTreeEvents, window.event, 'beforeopen', dir)
                await this.fileTreeHandle.openDirectory(dir as Directory)
                await this.changeResolvePath(dir as Directory)

                if (ref) {
                    ref.style.background = 'none'
                    const label$ = ref.querySelector('i.directory-toggle') as HTMLDivElement
                    if (label$) label$.classList.remove("loading");
                }

                this.events.dispatch(FileTreeXEvent.onTreeEvents, window.event, 'opened', dir)
            }
        }
    }

    private addIcon = async (pathOrDir: string | Directory, icon) => {
        const dir = typeof pathOrDir === 'string'
            ? await this.fileTreeHandle.getFileHandle(pathOrDir)
            : pathOrDir

        const ref = FileTreeItem.itemIdToRefMap.get(dir.id);
        if (ref) {
            const label$ = ref.querySelector('.file-label i') as HTMLDivElement
            label$.className = icon.icon;
        }

    }

    private addCssClass = async (pathOrDir: string | Directory, cssClass) => {
        const dir = typeof pathOrDir === 'string'
            ? await this.fileTreeHandle.getFileHandle(pathOrDir)
            : pathOrDir

        const ref = FileTreeItem.itemIdToRefMap.get(dir.id);
        if (ref) {
            ref.classList.add(cssClass)
            if (!dir._metadata.data.extraClasses)
                dir._metadata.data.extraClasses = []

            dir._metadata.data.extraClasses.push(cssClass)
        }

    }

    private supervisePrompt = (promptHandle: RenamePromptHandle | NewFilePromptHandle) => {
        const { mv, create, model } = this.props
        if (!promptHandle.destroyed) {
            // returning false from `onBlur` listener will prevent `PromptHandle` from being automatically destroyed
            promptHandle.onBlur(() => {
                return false
            })

            let didMarkInvalid = false
            promptHandle.onChange((currentValue) => {
                if (currentValue.trim() !== '' && !isValidFilename(currentValue)) {
                    promptHandle.addClassName('invalid')
                    didMarkInvalid = true
                } else {
                    if (didMarkInvalid) {
                        promptHandle.removeClassName('invalid')
                        didMarkInvalid = false
                    }
                }
            })

            let pulseTimer: number
            promptHandle.onCommit(async (newName) => {
                if (newName.trim() === '') {
                    return
                }
                if (!isValidFilename(newName)) {
                    promptHandle.addClassName('invalid')
                    clearTimeout(pulseTimer)
                    promptHandle.addClassName('invalid-input-pulse')
                    pulseTimer = setTimeout(() => {
                        promptHandle.removeClassName('invalid-input-pulse')
                    }, 600)
                    return false // prevent input from being destroyed
                } else {
                    promptHandle.removeClassName('invalid')
                    promptHandle.removeClassName('invalid-input-pulse')
                    if (promptHandle instanceof RenamePromptHandle) {
                        const target = promptHandle.target
                        const oldPath = target.path
                        const newPath = model.root.pathfx.join(target.parent.path, newName)
                        const res = await mv(oldPath, newPath)
                        // "truthy" values won't be enough, must be explicit `true`
                        if (res === true) {
                            this.fileTreeHandle.onceDidUpdate(() => {
                                this.fileTreeHandle.ensureVisible(target)
                            })
                            model.root.inotify({
                                type: WatchEvent.Moved,
                                oldPath,
                                newPath,
                            })
                        }
                    } else if (promptHandle instanceof NewFilePromptHandle) {
                        const parentDir = promptHandle.parent
                        const newPath = model.root.pathfx.join(parentDir.path, newName)
                        const maybeFile = await create(newPath, promptHandle.type)
                        if (maybeFile && maybeFile.type && maybeFile.name) {
                            model.root.inotify({
                                type: WatchEvent.Added,
                                directory: parentDir.path,
                                file: maybeFile,
                            })
                        }
                    }
                    // success or not, either way, proceed to destroy the PromptHandle
                }
            })
        }
    }

    private handleBlur = () => {
        this.events.dispatch(FileTreeXEvent.OnBlur)
    }

    private handleItemClicked = async (ev: React.MouseEvent, item: FileOrDir, type: ItemType) => {
        if (type === ItemType.Directory && ev.target.className.includes("directory-toggle")) {
            await this.toggleDirectory(item as Directory)
        }
        await this.setActiveFile(item as FileEntry)

    }

    private handleItemDoubleClicked = async (ev: React.MouseEvent, item: FileOrDir, type: ItemType) => {
        await this.toggleDirectory(item as Directory)
        await this.setActiveFile(item as FileEntry)

    }

    private handleContextMenu = (ev: React.MouseEvent) => {
        let target: FileOrDir
        // capture ctx menu triggered through context menu button on keyboard
        if (ev.nativeEvent.which === 0) {
            target = this.pseudoActiveFile || this.activeFile
            if (target) {
                const rect = FileTreeItem.getBoundingClientRectForItem(target)
                if (rect) {
                    console.log(rect)
                    return showContextMenu(ev, this.fileTreeHandle, target, { x: (rect.left + rect.width), y: (rect.top | rect.height) })
                }
            }
        }
        return showContextMenu(ev, this.fileTreeHandle, this.props.model.root)

    }

    private getItemFromDOM = (clientReact) => {
        return FileTreeItem.refToItemIdMap.get(clientReact);
    }

    private getDOMFromItem = (item: FileOrDir) => {
        return FileTreeItem.itemIdToRefMap.get(item.id);
    }

    private handleClick = (ev: React.MouseEvent) => {
        // clicked in "blank space"
        if (ev.currentTarget === ev.target) {
            this.setPseudoActiveFile(null)
        }
    }
    private handleItemCtxMenu = (ev: React.MouseEvent, item: FileOrDir) => {
        ev.stopPropagation()
        return showContextMenu(ev, this.fileTreeHandle, item)
    }

    private handleKeyDown = (ev: React.KeyboardEvent) => {
        return this.keyboardHotkeys.handleKeyDown(ev)
    }

    private onResize = (...args) => {
         if (this.wrapperRef.current != null) {
            this.resize()
         }
    }

    private resize = (scrollX, scrollY) => {
        const scrollXPos = scrollX ? scrollX : 0
        const scrollYPos = scrollY ? scrollY : this.props.model.state.scrollOffset
        const div = this.wrapperRef.current.querySelector('div').querySelector('div') as HTMLDivElement
        div.scroll(scrollXPos, scrollYPos)

    }

    private changeResolvePath = async (item: FileOrDir): Promise<void> => {
        // Change the path as per pgAdmin requirement: Item Id wise
        if (item.type === FileType.File) {
            item.resolvedPathCache = item.parent.path + "/" + item._metadata.data.id
        }
        if (item.type === FileType.Directory && item.children && item.children.length > 0) {
            for(let entry of item.children) {
                entry.resolvedPathCache = entry.parent.path + "/" + entry._metadata.data.id
            }
        }
    }
}

export { IFileTreeXHandle, IFileTreeXProps }
