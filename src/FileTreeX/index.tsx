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
                onEvent={this.handleTreeEvent}>
                {(props: IItemRendererProps) => <FileTreeItem
                    item={props.item}
                    itemType={props.itemType}
                    decorations={decorations.getDecorations(props.item as any)}
                    dndService={this.dndService}
                    onClick={this.handleItemClicked}
                    onContextMenu={this.handleItemCtxMenu} />}
            </FileTree>
        </div>
    }

    public componentDidMount() {
        this.fileTreeEvent = this.props.onEvent
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
            children: this.children
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
        if(!await this.fileTreeEvent.onEvent(window.event, 'selected', fileH)) {
            throw new Error("selected failed.");
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
        if(!await this.fileTreeEvent.onEvent(window.event, 'selected', fileH)) {
            throw new Error("selected failed.");
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
             return fileH._metadata
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
                if(!await this.fileTreeEvent.onEvent(window.event, 'closed', dir)) {
                    throw new Error("Closed failed.");
                }
            } else {
                if(!await this.fileTreeEvent.onEvent(window.event, 'beforeopen', dir)) {
                    throw new Error("Beforeopen failed.");
                }
                await this.fileTreeHandle.openDirectory(dir as Directory)
                if(!await this.fileTreeEvent.onEvent(window.event, 'opened', dir)) {
                    throw new Error("Opened failed.");
                }
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
        if (type === ItemType.Directory) {
            await this.toggleDirectory(item as Directory)
        }
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

    private handleClick = (ev: React.MouseEvent) => {
        // clicked in "blank space"
        console.log(ev)
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
