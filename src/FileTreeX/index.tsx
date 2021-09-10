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
            tabIndex={-1}>
            <FileTree
                height={height}
                width={width}
                model={model}
                itemHeight={FileTreeItem.renderHeight}
                onReady={this.handleTreeReady}
                ref={this.wrapperRef}>
                {(props: IItemRendererProps) => <FileTreeItem
                    item={props.item}
                    itemType={props.itemType}
                    decorations={decorations.getDecorations(props.item as any)}
                    dndService={this.dndService}
                    onClick={this.handleItemClicked}
                    onDoubleClick={this.handleItemDoubleClicked}
                    onContextMenu={this.handleItemCtxMenu}
                    events={this.events}/>}
            </FileTree>
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
            onTreeEvents: (callback) => this.events.add(FileTreeXEvent.onTreeEvents, callback),
            addIcon: this.addIcon,
            create: this.create,
            remove: this.remove,
            update: this.update,
            refresh: this.refresh,
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

    private setActiveFile = async (fileOrDirOrPath: FileOrDir | string): Promise<void> => {
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
        }
        if (fileH) {
            await this.fileTreeHandle.ensureVisible(fileH)
        }
        this.events.dispatch(FileTreeXEvent.onTreeEvents, window.event, 'selected', fileH)

    }

    private deSelectActiveFile = async (fileOrDirOrPath: FileOrDir | string): Promise<void> => {
        const fileH = typeof fileOrDirOrPath === 'string'
            ? await this.fileTreeHandle.getFileHandle(fileOrDirOrPath)
            : fileOrDirOrPath

        if (fileH === this.props.model.root) { return }
        if (this.activeFile === fileH) {
            this.activeFileDec.removeTarget(this.activeFile)
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
        const {create, model } = this.props
        const maybeFile = await create(parentDir.path, itemData)
        if (maybeFile && maybeFile.type && maybeFile.name) {
            model.root.inotify({
                type: WatchEvent.Added,
                directory: parentDir.path,
                file: maybeFile,
            })
        }
    }

    private updateFileOrFolder = async (item, itemData): Promise<void> => {
        const {create, model } = this.props
        await update(item, itemData)

    }

     private refresh = async (item): Promise<void> => {
         const {remove, model } = this.props
         const isOpen = item.isExpanded
         if (item.children && item.children.length > 0) {
             for(let entry of item.children) {
                 await this.removeFileOrFolder(entry).then(val => {}, error => {console.warn(error)})
             }
         }
         if (isOpen) {
             this.fileTreeHandle.closeDirectory(item as Directory)
             this.fileTreeHandle.openDirectory(item as Directory)
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
            const item_1 = parent._children.find((c) => c._metadata.data.id === fileName);
            if (item_1) {
                parent.unlinkItem(item_1);
                if (parent._children.length == 0) { parent._children = null }
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
                    label$.className = "directory-loading";
                }

                this.events.dispatch(FileTreeXEvent.onTreeEvents, window.event, 'beforeopen', dir)
                await this.fileTreeHandle.openDirectory(dir as Directory)

                if (dir.children && dir.children.length > 0) {
                    for(let entry of dir.children) {
                       entry.resolvedPathCache = entry.parent.path + "/" + entry._metadata.data.id
                    }
                }

                if (ref) {
                    ref.style.background = 'none'
                    const label$ = ref.querySelector('i.directory-loading') as HTMLDivElement
                    label$.className = "directory-toggle";
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
            ref.style.background = 'none'
            const label$ = ref.querySelector('.file-label i') as HTMLDivElement
            label$.className = icon.icon;
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
            const item_1 = parent._children.find((c) => c._metadata.data.id === fileName);
            if (item_1) {
                parent.unlinkItem(item_1);
                if (parent._children.length == 0) { parent._children = null }
            }
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
        this.setActiveFile(item as FileEntry)
        if (type === ItemType.Directory && ev.target.className.includes("directory-toggle")) {
            await this.toggleDirectory(item as Directory)
        }
    }

    private handleItemDoubleClicked = async (ev: React.MouseEvent, item: FileOrDir, type: ItemType) => {
        this.setActiveFile(item as FileEntry)
        await this.toggleDirectory(item as Directory)
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
        return FileTreeItem.itemIdToRefMap.get(clientReact);
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
}

export { IFileTreeXHandle, IFileTreeXProps }
